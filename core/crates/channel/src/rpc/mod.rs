//! 连接之上的最小 JSON-RPC 2.0 对端。
//!
//! 双方都可以请求和响应；参数只用按名传递的对象。一个读线程负责收消息：应答交给等待中的请求，
//! 请求与通知在读线程上同步调用处理函数。处理函数应当很快返回，且不能在里面调用本对端的 `request`。

mod wire;

pub use wire::{
    CallError, RPC_CANCEL, RpcError, RpcErrorCode, RpcId, RpcKind, classify, is_cancel_params,
};

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::connection::{Connection, Message};
use crate::error::{ChannelError, ErrorCode};
use wire::{
    error_object, failure_envelope, notification_envelope, request_envelope, rpc_id,
    success_envelope,
};

type RequestHandler = Box<dyn Fn(&Map<String, Value>) -> Result<Value, RpcError> + Send + Sync>;
type AfterReply = Box<dyn Fn() + Send + Sync>;
type NotificationHandler = Box<dyn Fn(&Map<String, Value>) + Send + Sync>;

/// 处理函数表，在启动对端前登记。
#[derive(Default)]
pub struct Handlers {
    requests: HashMap<String, (RequestHandler, Option<AfterReply>)>,
    notifications: HashMap<String, NotificationHandler>,
}

fn check_method(method: &str, taken: bool) {
    assert!(!method.starts_with("rpc."), "rpc. 前缀保留给协议自身");
    assert!(!taken, "方法 {method} 已有处理函数");
}

impl Handlers {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记请求处理函数。
    ///
    /// # Panics
    ///
    /// 方法名以 `rpc.` 开头或已登记时 panic。
    #[must_use]
    pub fn request(
        mut self,
        method: &str,
        handler: impl Fn(&Map<String, Value>) -> Result<Value, RpcError> + Send + Sync + 'static,
    ) -> Self {
        check_method(method, self.requests.contains_key(method));
        self.requests
            .insert(method.to_owned(), (Box::new(handler), None));
        self
    }

    /// 同 `request`，另在应答写出之后在读线程上调用 `after_reply`。
    ///
    /// 用于先应答、再收尾的请求（例如 `shutdown`）。
    ///
    /// # Panics
    ///
    /// 方法名以 `rpc.` 开头或已登记时 panic。
    #[must_use]
    pub fn request_then(
        mut self,
        method: &str,
        handler: impl Fn(&Map<String, Value>) -> Result<Value, RpcError> + Send + Sync + 'static,
        after_reply: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        check_method(method, self.requests.contains_key(method));
        self.requests.insert(
            method.to_owned(),
            (Box::new(handler), Some(Box::new(after_reply))),
        );
        self
    }

    /// 登记通知处理函数。
    ///
    /// # Panics
    ///
    /// 方法名以 `rpc.` 开头或已登记时 panic。
    #[must_use]
    pub fn notification(
        mut self,
        method: &str,
        handler: impl Fn(&Map<String, Value>) + Send + Sync + 'static,
    ) -> Self {
        check_method(method, self.notifications.contains_key(method));
        self.notifications
            .insert(method.to_owned(), Box::new(handler));
        self
    }
}

#[derive(Clone, Debug)]
pub struct RpcOptions {
    /// 请求的默认截止时间。
    pub timeout: Duration,
}

type Reply = Result<Value, CallError>;

enum State {
    Open,
    /// 连接已关闭；正常关闭时为 None。
    Closed(Option<ChannelError>),
}

struct Shared {
    connection: Connection,
    timeout: Duration,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, mpsc::Sender<Reply>>>,
    state: Mutex<State>,
    closed: Condvar,
}

/// 连接之上的 JSON-RPC 2.0 对端。析构时关闭连接并等读线程结束。
pub struct RpcPeer {
    shared: Arc<Shared>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl RpcPeer {
    /// 启动读线程。
    ///
    /// # Errors
    ///
    /// 无法创建线程时返回 IO 错误。
    pub fn spawn(
        connection: Connection,
        handlers: Handlers,
        options: &RpcOptions,
    ) -> io::Result<Self> {
        let shared = Arc::new(Shared {
            connection,
            timeout: options.timeout,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            state: Mutex::new(State::Open),
            closed: Condvar::new(),
        });
        let reader = thread::Builder::new()
            .name("bellis-channel-rpc".to_owned())
            .spawn({
                let shared = Arc::clone(&shared);
                move || shared.read_loop(&handlers)
            })?;
        Ok(Self {
            shared,
            reader: Mutex::new(Some(reader)),
        })
    }

    #[must_use]
    pub fn connection(&self) -> &Connection {
        &self.shared.connection
    }

    /// 发出请求并阻塞等待应答，截止时间为 `RpcOptions::timeout`。
    ///
    /// # Errors
    ///
    /// 超过截止时间为 `timeout`（并向对端发 `rpc.cancel`）；连接关闭为 `closed`；
    /// 对端返回错误时为 `CallError::Rpc`。
    pub fn request(
        &self,
        method: &str,
        params: Option<&Map<String, Value>>,
    ) -> Result<Value, CallError> {
        self.request_with_timeout(method, params, self.shared.timeout)
    }

    /// 同 `request`，但截止时间由调用方给出。
    ///
    /// # Errors
    ///
    /// 同 `request`。
    pub fn request_with_timeout(
        &self,
        method: &str,
        params: Option<&Map<String, Value>>,
        timeout: Duration,
    ) -> Result<Value, CallError> {
        let shared = &self.shared;
        let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        shared.pending().insert(id, sender);
        if !matches!(*shared.state(), State::Open) {
            shared.pending().remove(&id);
            return Err(closed_before_reply().into());
        }
        if let Err(error) = shared
            .connection
            .send_json_bytes(&request_envelope(id, method, params))
        {
            shared.pending().remove(&id);
            return Err(error.into());
        }
        match receiver.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => {
                shared.pending().remove(&id);
                if shared.connection.is_open() {
                    let mut cancel = Map::new();
                    cancel.insert("id".to_owned(), Value::from(id));
                    let _ = shared
                        .connection
                        .send_json_bytes(&notification_envelope(RPC_CANCEL, Some(&cancel)));
                }
                Err(ChannelError::new(
                    ErrorCode::Timeout,
                    format!("{method} 未在 {}ms 内响应", timeout.as_millis()),
                )
                .into())
            }
            Err(RecvTimeoutError::Disconnected) => Err(closed_before_reply().into()),
        }
    }

    /// 发出通知。
    ///
    /// # Errors
    ///
    /// 超出帧长上限或连接已关闭时返回错误。
    pub fn notify(
        &self,
        method: &str,
        params: Option<&Map<String, Value>>,
    ) -> Result<(), ChannelError> {
        self.shared
            .connection
            .send_json_bytes(&notification_envelope(method, params))
    }

    /// 连接是否已关闭（读线程已结束或即将结束）。
    #[must_use]
    pub fn is_closed(&self) -> bool {
        !matches!(*self.shared.state(), State::Open)
    }

    /// 等连接关闭，最多等 `timeout`。已关闭时返回 `Some(原因)`，正常关闭的原因为 None。
    #[must_use]
    pub fn wait_closed(&self, timeout: Option<Duration>) -> Option<Option<ChannelError>> {
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        let mut state = self.shared.state();
        loop {
            if let State::Closed(reason) = &*state {
                return Some(reason.clone());
            }
            match deadline {
                None => {
                    state = self
                        .shared
                        .closed
                        .wait(state)
                        .unwrap_or_else(PoisonError::into_inner);
                }
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return None;
                    }
                    state = self
                        .shared
                        .closed
                        .wait_timeout(state, left)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0;
                }
            }
        }
    }

    /// 关闭连接并等读线程结束（在读线程里调用时不等）。
    pub fn close(&self) {
        self.shared.connection.close();
        let reader = self
            .reader
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(reader) = reader
            && reader.thread().id() != thread::current().id()
        {
            let _ = reader.join();
        }
    }
}

impl Drop for RpcPeer {
    fn drop(&mut self) {
        self.close();
    }
}

fn closed_before_reply() -> ChannelError {
    ChannelError::new(ErrorCode::Closed, "连接已关闭，请求未完成")
}

struct CloseOnExit<'a> {
    shared: &'a Shared,
    reason: Option<ChannelError>,
}

impl Drop for CloseOnExit<'_> {
    fn drop(&mut self) {
        self.shared.on_close(self.reason.take());
    }
}

impl Shared {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<i64, mpsc::Sender<Reply>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn read_loop(&self, handlers: &Handlers) {
        let mut exit = CloseOnExit {
            shared: self,
            reason: None,
        };
        loop {
            match self.connection.recv(None) {
                Ok(Message::Json(message)) => self.receive(&message, handlers),
                Ok(Message::Binary(_)) => {}
                Err(error) => {
                    exit.reason = (error.code() != ErrorCode::Closed).then_some(error);
                    return;
                }
            }
        }
    }

    fn receive(&self, message: &Value, handlers: &Handlers) {
        match classify(message) {
            RpcKind::Invalid => self.reply(&failure_envelope(
                None,
                &RpcError::new(RpcErrorCode::INVALID_REQUEST, "Invalid Request"),
            )),
            RpcKind::Request => self.serve(message, handlers),
            RpcKind::Notification => {
                let method = message["method"].as_str().unwrap_or_default();
                if method == RPC_CANCEL {
                    return;
                }
                if let Some(handler) = handlers.notifications.get(method) {
                    handler(&params(message));
                }
            }
            RpcKind::Success => self.settle(&message["id"], Ok(message["result"].clone())),
            RpcKind::Failure => {
                if let Some((code, text, data)) = error_object(&message["error"]) {
                    let error = RpcError {
                        code,
                        message: text.to_owned(),
                        data: data.cloned(),
                    };
                    self.settle(&message["id"], Err(CallError::Rpc(error)));
                }
            }
        }
    }

    fn settle(&self, id: &Value, reply: Reply) {
        if let Some(RpcId::Int(id)) = rpc_id(id)
            && let Some(sender) = self.pending().remove(&id)
        {
            let _ = sender.send(reply);
        }
    }

    fn serve(&self, request: &Value, handlers: &Handlers) {
        let Some(id) = rpc_id(&request["id"]) else {
            return;
        };
        let method = request["method"].as_str().unwrap_or_default();
        let Some((handler, after_reply)) = handlers.requests.get(method) else {
            self.reply(&failure_envelope(
                Some(&id),
                &RpcError::new(
                    RpcErrorCode::METHOD_NOT_FOUND,
                    format!("Method not found: {method}"),
                ),
            ));
            return;
        };
        let internal = || RpcError::new(RpcErrorCode::INTERNAL_ERROR, "Internal error");
        match handler(&params(request)) {
            Ok(result) => {
                if let Err(error) = self
                    .connection
                    .send_json_bytes(&success_envelope(&id, &result))
                    && error.code() == ErrorCode::FrameTooLarge
                {
                    self.reply(&failure_envelope(Some(&id), &internal()));
                }
            }
            Err(error) => self.reply(&failure_envelope(Some(&id), &error)),
        }
        if let Some(after_reply) = after_reply {
            after_reply();
        }
    }

    fn reply(&self, envelope: &[u8]) {
        if self.connection.is_open() {
            let _ = self.connection.send_json_bytes(envelope);
        }
    }

    fn on_close(&self, reason: Option<ChannelError>) {
        self.connection.close();
        {
            let mut state = self.state();
            if matches!(*state, State::Open) {
                *state = State::Closed(reason);
            }
        }
        self.closed.notify_all();
        let pending: Vec<_> = self.pending().drain().map(|(_, sender)| sender).collect();
        for sender in pending {
            let _ = sender.send(Err(closed_before_reply().into()));
        }
    }
}

fn params(message: &Value) -> Map<String, Value> {
    message
        .get("params")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
