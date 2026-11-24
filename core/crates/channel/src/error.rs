//! 本机通道的错误。

use std::fmt;

/// 本机通道错误码。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// 监听地址已被占用：会话地址每次随机生成，出现即视为可能被抢注，不得用同名重试。
    AddressInUse,
    /// 地址或会话密钥的文本不合法。
    AddressInvalid,
    /// 会话密钥长度不对。
    InvalidKey,
    /// 同时进行的未认证握手已达上限。
    Busy,
    /// 连接不到对端。
    ConnectFailed,
    /// 对端未能证明持有会话密钥。
    AuthFailed,
    HandshakeTimeout,
    FrameTooLarge,
    /// 帧或消息不符合协议。
    ProtocolError,
    /// 读取或请求超过截止时间。
    Timeout,
    Closed,
}

impl ErrorCode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AddressInUse => "address-in-use",
            Self::AddressInvalid => "address-invalid",
            Self::InvalidKey => "invalid-key",
            Self::Busy => "busy",
            Self::ConnectFailed => "connect-failed",
            Self::AuthFailed => "auth-failed",
            Self::HandshakeTimeout => "handshake-timeout",
            Self::FrameTooLarge => "frame-too-large",
            Self::ProtocolError => "protocol-error",
            Self::Timeout => "timeout",
            Self::Closed => "closed",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 本机通道的错误：错误码加一句说明。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelError {
    code: ErrorCode,
    message: String,
}

impl ChannelError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn code(&self) -> ErrorCode {
        self.code
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ChannelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ChannelError {}
