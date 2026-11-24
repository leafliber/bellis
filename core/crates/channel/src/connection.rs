//! 已认证的本机连接（客户端一侧）。

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::address::{SessionKey, fill_random};
use crate::error::{ChannelError, ErrorCode};
use crate::frame::{FRAME_HEADER_BYTES, Frame, FrameKind, encode_frame, parse_header};
use crate::handshake::{ClientHandshake, NONCE_BYTES, is_valid_role};
use crate::json;
use crate::transport::{Transport, open_transport};

/// 认证前单帧上限：握手消息都很小，避免未认证的对端占用内存。
pub const HANDSHAKE_MAX_FRAME_BYTES: usize = 1024;
/// 认证后单帧负载的缺省上限。
pub const DEFAULT_MAX_FRAME_BYTES: usize = 1024 * 1024;
/// 握手须在此时限内完成。
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(2000);

const READ_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct ConnectionOptions {
    /// 握手（含连接管道时等待忙实例）须在此时限内完成，缺省 2000ms。
    pub handshake_timeout: Duration,
    /// 认证后单帧负载的上限，缺省 1 MiB。收发两个方向都按它检查。
    pub max_frame_bytes: usize,
}

impl Default for ConnectionOptions {
    fn default() -> Self {
        Self {
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
        }
    }
}

/// 认证后收到的一条消息。
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Json(Value),
    Binary(Vec<u8>),
}

/// 从字节流逐帧读取。读超时时已读到的字节留在缓冲区里，下次接着读，不失步。
struct FrameReader {
    buffer: Vec<u8>,
    scratch: Vec<u8>,
}

impl FrameReader {
    fn new() -> Self {
        Self {
            buffer: Vec::new(),
            scratch: vec![0; READ_CHUNK_BYTES],
        }
    }

    fn read(
        &mut self,
        transport: &dyn Transport,
        max_payload_bytes: usize,
        deadline: Option<Instant>,
    ) -> Result<Frame, ChannelError> {
        loop {
            if let Some(header) = self.buffer.first_chunk::<FRAME_HEADER_BYTES>() {
                let (kind, length) = parse_header(*header, max_payload_bytes)?;
                let end = FRAME_HEADER_BYTES + length;
                if self.buffer.len() >= end {
                    let payload = self.buffer[FRAME_HEADER_BYTES..end].to_vec();
                    self.buffer.drain(..end);
                    return Ok(Frame { kind, payload });
                }
            }
            match transport.read(&mut self.scratch, deadline) {
                Ok(0) => return Err(ChannelError::new(ErrorCode::Closed, "连接已关闭")),
                Ok(count) => self.buffer.extend_from_slice(&self.scratch[..count]),
                Err(error) => return Err(io_error(&error)),
            }
        }
    }
}

fn io_error(error: &io::Error) -> ChannelError {
    match error.kind() {
        io::ErrorKind::TimedOut => {
            ChannelError::new(ErrorCode::Timeout, "超过截止时间仍未收到完整的帧")
        }
        _ => ChannelError::new(ErrorCode::Closed, format!("连接已断开：{error}")),
    }
}

/// 一条已认证的本机连接。可以在线程间共享：一个线程读，其它线程写。
pub struct Connection {
    transport: Arc<dyn Transport>,
    reader: Mutex<FrameReader>,
    role: String,
    max_frame_bytes: usize,
    failed: Mutex<Option<ChannelError>>,
    closed: AtomicBool,
}

impl Connection {
    /// 在给定的字节流上以 `role` 发起握手，成功后返回连接。
    ///
    /// # Errors
    ///
    /// 角色名不合法、服务端未能证明持有密钥（`auth-failed`）、握手超时、帧超长或消息不合法时
    /// 返回错误，并断开字节流。
    pub fn open(
        transport: Box<dyn Transport>,
        role: &str,
        key: &SessionKey,
        options: &ConnectionOptions,
    ) -> Result<Self, ChannelError> {
        let mut nonce = [0u8; NONCE_BYTES];
        fill_random(&mut nonce);
        Self::open_with_nonce(transport, role, key, options, &nonce)
    }

    pub(crate) fn open_with_nonce(
        transport: Box<dyn Transport>,
        role: &str,
        key: &SessionKey,
        options: &ConnectionOptions,
        nonce: &[u8; NONCE_BYTES],
    ) -> Result<Self, ChannelError> {
        let transport: Arc<dyn Transport> = Arc::from(transport);
        let handshake = match ClientHandshake::new(key, role, nonce) {
            Ok(handshake) => handshake,
            Err(error) => {
                transport.shutdown();
                return Err(error);
            }
        };
        let deadline = Instant::now() + options.handshake_timeout;
        let mut reader = FrameReader::new();
        let write = |bytes: &[u8]| {
            transport
                .write_all(bytes, Some(deadline))
                .map_err(|error| io_error(&error))
        };
        let result = (|| {
            write(&handshake.hello())?;
            let challenge = reader.read(&*transport, HANDSHAKE_MAX_FRAME_BYTES, Some(deadline))?;
            write(&handshake.on_challenge(&challenge)?)?;
            let accept = reader.read(&*transport, HANDSHAKE_MAX_FRAME_BYTES, Some(deadline))?;
            handshake.on_accept(&accept)
        })();
        if let Err(error) = result {
            transport.shutdown();
            return Err(match error.code() {
                ErrorCode::Timeout => ChannelError::new(
                    ErrorCode::HandshakeTimeout,
                    format!(
                        "握手未在 {}ms 内完成",
                        options.handshake_timeout.as_millis()
                    ),
                ),
                ErrorCode::Closed => ChannelError::new(ErrorCode::Closed, "握手完成前连接已关闭"),
                _ => error,
            });
        }
        Ok(Self {
            transport,
            reader: Mutex::new(reader),
            role: role.to_owned(),
            max_frame_bytes: options.max_frame_bytes,
            failed: Mutex::new(None),
            closed: AtomicBool::new(false),
        })
    }

    /// 本连接认证时声明的角色。
    #[must_use]
    pub fn role(&self) -> &str {
        &self.role
    }

    #[must_use]
    pub fn is_open(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self
                .failed
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_none()
    }

    /// 发送一条 JSON 消息。
    ///
    /// # Errors
    ///
    /// 超出帧长上限时为 `frame-too-large`，连接不受影响；连接已关闭或写入失败时为 `closed`。
    pub fn send(&self, message: &Value) -> Result<(), ChannelError> {
        self.send_frame(FrameKind::Json, &json::dumps(message), None)
    }

    /// 在时限内写完整的 JSON 帧。
    ///
    /// # Errors
    ///
    /// 同 `send`。写入超时后关闭连接，避免对端持有半帧。
    pub fn send_with_timeout(
        &self,
        message: &Value,
        timeout: Duration,
    ) -> Result<(), ChannelError> {
        self.send_frame(
            FrameKind::Json,
            &json::dumps(message),
            Some(Instant::now() + timeout),
        )
    }

    /// 发送一帧二进制数据。
    ///
    /// # Errors
    ///
    /// 同 `send`。
    pub fn send_binary(&self, data: &[u8]) -> Result<(), ChannelError> {
        self.send_frame(FrameKind::Binary, data, None)
    }

    pub(crate) fn send_json_bytes(&self, payload: &[u8]) -> Result<(), ChannelError> {
        self.send_frame(FrameKind::Json, payload, None)
    }

    fn send_frame(
        &self,
        kind: FrameKind,
        payload: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), ChannelError> {
        if !self.is_open() {
            return Err(ChannelError::new(ErrorCode::Closed, "连接未打开"));
        }
        if payload.len() > self.max_frame_bytes {
            return Err(ChannelError::new(
                ErrorCode::FrameTooLarge,
                format!(
                    "负载 {} 字节超过上限 {}",
                    payload.len(),
                    self.max_frame_bytes
                ),
            ));
        }
        self.transport
            .write_all(&encode_frame(kind, payload), deadline)
            .map_err(|error| {
                let error = if error.kind() == io::ErrorKind::TimedOut {
                    ChannelError::new(ErrorCode::Timeout, "超过截止时间仍未写出完整的帧")
                } else {
                    io_error(&error)
                };
                self.fail(error)
            })
    }

    /// 接收下一条消息，阻塞到收到为止或超过 `timeout`。
    ///
    /// # Errors
    ///
    /// 超过 `timeout` 时为 `timeout`，连接仍可用；对端关闭时为 `closed`；协议违规时断开并返回错误。
    pub fn recv(&self, timeout: Option<Duration>) -> Result<Message, ChannelError> {
        let frame = self.recv_frame(timeout)?;
        if frame.kind == FrameKind::Json {
            return json::loads(&frame.payload, "消息")
                .map(Message::Json)
                .map_err(|error| self.fail(error));
        }
        Ok(Message::Binary(frame.payload))
    }

    /// 接收认证后的 JSON 或二进制帧。
    ///
    /// # Errors
    ///
    /// 读超时保留半帧。其它读取错误、帧长/类型非法或认证后收到握手帧时关闭连接。
    pub fn recv_frame(&self, timeout: Option<Duration>) -> Result<Frame, ChannelError> {
        if let Some(error) = self.failure() {
            return Err(error);
        }
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        let frame = {
            let mut reader = self.reader.lock().unwrap_or_else(PoisonError::into_inner);
            reader.read(&*self.transport, self.max_frame_bytes, deadline)
        };
        let frame = match frame {
            Ok(frame) => frame,
            Err(error) if error.code() == ErrorCode::Timeout => return Err(error),
            Err(error) => return Err(self.fail(error)),
        };
        if frame.kind == FrameKind::Handshake {
            return Err(self.fail(ChannelError::new(
                ErrorCode::ProtocolError,
                "认证后收到握手帧",
            )));
        }
        Ok(frame)
    }

    /// 断开连接，唤醒阻塞中的 `recv`。可以从任一线程调用，可以重复调用。
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.transport.shutdown();
    }

    fn failure(&self) -> Option<ChannelError> {
        if let Some(error) = self
            .failed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        {
            return Some(error);
        }
        self.closed
            .load(Ordering::Acquire)
            .then(|| ChannelError::new(ErrorCode::Closed, "连接已关闭"))
    }

    fn fail(&self, error: ChannelError) -> ChannelError {
        self.failed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_or_insert_with(|| error.clone());
        self.transport.shutdown();
        error
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.transport.shutdown();
    }
}

/// 以给定角色连接本机通道，握手成功后返回连接。
///
/// # Errors
///
/// 角色名不合法时为 `protocol-error`；连不上时为 `connect-failed`；其余同 `Connection::open`。
pub fn connect(
    path: &str,
    role: &str,
    key: &SessionKey,
    options: &ConnectionOptions,
) -> Result<Connection, ChannelError> {
    if !is_valid_role(role) {
        return Err(ChannelError::new(
            ErrorCode::ProtocolError,
            format!("角色名不合法：{role}"),
        ));
    }
    let transport = open_transport(path, options.handshake_timeout)?;
    Connection::open(transport, role, key, options)
}
