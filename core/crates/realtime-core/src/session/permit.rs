//! 统一许可控制连接：无论独立控制台还是未来的 Host，实时核只讲同一套 5 个 RPC 方法。
//!
//! - 许可源 → 实时核（请求）：`lease.renew`、`lease.revoke`、`input.stop`
//! - 实时核 → 许可源（通知）：`input.released`、`health`
//!
//! 连接断开即触发 `Control::lease_source_lost()` 并全量释放输入，永不重连。

use std::io;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use bellis_channel::{
    ChannelCredentials, ChannelError, Connection, ConnectionOptions, Handlers, RpcError,
    RpcErrorCode, RpcOptions, RpcPeer, connect,
};
use serde_json::{Map, Value, json};

use super::config::ChannelSource;
use super::cred::read_session_info;
use super::queue::SendQueue;
use crate::clock;
use crate::control::{Control, LeaseGrant};
use crate::input::win32_hooks::Post;
use crate::protocol::{
    Empty, InputStopParams, InputStopResult, LeaseRenewParams, LeaseRevokeParams, error_code,
    permit_methods,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(2);

/// 按 [`ChannelSource`] 解析核通道或许可控制连接的通道凭据。
///
/// # Errors
///
/// 凭据管理器读取失败、内容非法或 `sessionId` 不匹配时返回 IO 错误。
pub(crate) fn resolve_credentials(
    source: &ChannelSource,
    label: &str,
) -> io::Result<ChannelCredentials> {
    match source {
        ChannelSource::Direct(credentials) => Ok(credentials.clone()),
        ChannelSource::CredMan {
            target,
            expected_session_id,
        } => {
            let session = read_session_info(target)?;
            if let Some(expected) = expected_session_id
                && session.id != *expected
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "{label} credential sessionId {:?} does not match expected {expected:?}",
                        session.id
                    ),
                ));
            }
            Ok(session.credentials)
        }
    }
}

/// 连接许可控制对端并完成 `bellis-channel/1` 握手。
///
/// # Errors
///
/// 连接或握手失败时返回通道错误。
pub(crate) fn connect_permit(
    credentials: &ChannelCredentials,
    role: &str,
) -> Result<Connection, ChannelError> {
    connect(
        &credentials.path,
        role,
        &credentials.key,
        &ConnectionOptions::default(),
    )
}

/// 运行中的统一许可控制连接（读线程 + 异步发送线程 + 断连撤权生命线）。
pub(crate) struct PermitConnection {
    peer: Arc<RpcPeer>,
    queue: Arc<SendQueue>,
    sender: Option<JoinHandle<()>>,
}

impl PermitConnection {
    /// 启动统一许可控制连接的处理循环、通知发送线程与生命线线程。
    ///
    /// # Errors
    ///
    /// 无法创建线程时返回 IO 错误。
    pub(crate) fn start(
        connection: Connection,
        queue: Arc<SendQueue>,
        control: &Arc<Control>,
        post: &Post,
    ) -> io::Result<Self> {
        let handlers = permit_handlers(control, post);
        let peer = Arc::new(RpcPeer::spawn(
            connection,
            handlers,
            &RpcOptions {
                timeout: RPC_TIMEOUT,
            },
        )?);
        let mut permit = Self {
            peer: Arc::clone(&peer),
            queue: Arc::clone(&queue),
            sender: None,
        };
        let sender = thread::Builder::new()
            .name("permit-sender".into())
            .spawn(move || {
                let mut failed = false;
                queue.run(|method, params| {
                    if let Err(error) = peer.notify(method, Some(params))
                        && !failed
                    {
                        log!("permit: {method} not sent: {error}");
                        failed = true;
                    }
                });
            })?;
        permit.sender = Some(sender);
        permit.spawn_lifeline(control, post)?;
        Ok(permit)
    }

    fn spawn_lifeline(&self, control: &Arc<Control>, post: &Post) -> io::Result<()> {
        let (peer, control, post) = (
            Arc::clone(&self.peer),
            Arc::clone(control),
            Arc::clone(post),
        );
        thread::Builder::new()
            .name("permit-lifeline".into())
            .spawn(move || {
                let reason = peer.wait_closed(None).flatten();
                let notices = control.lease_source_lost();
                if !notices.is_empty() {
                    log!(
                        "permit connection closed ({}); no lease from now on",
                        reason.map_or_else(|| "by the peer".to_owned(), |e| e.to_string())
                    );
                }
                post(notices);
            })?;
        Ok(())
    }

    /// 退出前等待待发通知（如最终 `input.released`）冲刷完毕，再关闭连接。
    pub(crate) fn finish(mut self, timeout: Duration) {
        if !self.queue.flush(timeout) {
            log!(
                "permit: notifications not flushed within {}ms",
                timeout.as_millis()
            );
        }
        self.close();
    }

    fn close(&mut self) {
        self.queue.abandon();
        self.peer.close();
        if let Some(sender) = self.sender.take() {
            let _ = sender.join();
        }
    }
}

impl Drop for PermitConnection {
    fn drop(&mut self) {
        self.close();
    }
}

fn parse<T: serde::de::DeserializeOwned>(
    method: &str,
    params: &Map<String, Value>,
) -> Result<T, RpcError> {
    serde_json::from_value(Value::Object(params.clone())).map_err(|error| {
        RpcError::new(
            RpcErrorCode::INVALID_PARAMS,
            format!("invalid params for {method}: {error}"),
        )
    })
}

fn empty() -> Value {
    serde_json::to_value(Empty {}).unwrap_or_else(|_| Value::Object(Map::new()))
}

fn permit_handlers(control: &Arc<Control>, post: &Post) -> Handlers {
    let renew = {
        let (control, post) = (Arc::clone(control), Arc::clone(post));
        move |params: &Map<String, Value>| {
            let params: LeaseRenewParams = parse(permit_methods::LEASE_RENEW, params)?;
            let (result, notices) = control.grant_lease(&params, clock::now_ns);
            post(notices);
            let result = result.and_then(|grant| match grant {
                LeaseGrant::Applied => Ok(()),
                LeaseGrant::Verifying(release_id) => {
                    control.wait_for_lease_proof(release_id)?;
                    control.confirm_lease_grant(&params, release_id, clock::now_ns)
                }
            });
            match result {
                Ok(()) => Ok(empty()),
                Err(refusal) => {
                    log!("{} refused: {refusal}", permit_methods::LEASE_RENEW);
                    Err(RpcError::new(
                        error_code::LEASE_REFUSED,
                        refusal.to_string(),
                    ))
                }
            }
        }
    };
    let revoke = {
        let (control, post) = (Arc::clone(control), Arc::clone(post));
        move |params: &Map<String, Value>| {
            let params: LeaseRevokeParams = parse(permit_methods::LEASE_REVOKE, params)?;
            post(control.revoke_lease(params.token, clock::now_ns));
            Ok(empty())
        }
    };
    let stop = {
        let (control, post) = (Arc::clone(control), Arc::clone(post));
        move |params: &Map<String, Value>| {
            let params: InputStopParams = parse(permit_methods::INPUT_STOP, params)?;
            let (release_id, notices) = control.stop_input(params.through_token, clock::now_ns);
            post(notices);
            Ok(json!(InputStopResult { release_id }))
        }
    };
    Handlers::new()
        .request(permit_methods::LEASE_RENEW, renew)
        .request(permit_methods::LEASE_REVOKE, revoke)
        .request(permit_methods::INPUT_STOP, stop)
}
