//! 本机通道 `bellis-channel/1` 的 Rust 客户端与最小 JSON-RPC 2.0 对端。
//!
//! 纯传输 + 双向 HMAC-SHA256 认证 + 长度前缀帧 + JSON-RPC 2.0 `RpcPeer`，绝不耦合任何业务消息类型。
//! 不用异步运行时：标准线程加阻塞/重叠 IO，读取可设截止时间。

mod address;
mod base64url;
mod connection;
mod error;
mod frame;
mod handshake;
mod json;
mod rpc;
mod transport;

pub use address::{
    ChannelCredentials, MAX_UDS_PATH_BYTES, SESSION_KEY_BYTES, SessionKey, channel_name,
    create_channel_path, create_session_key, decode_session_key, encode_session_key,
};
pub use connection::{
    Connection, ConnectionOptions, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_MAX_FRAME_BYTES,
    HANDSHAKE_MAX_FRAME_BYTES, Message, connect,
};
pub use error::{ChannelError, ErrorCode};
pub use frame::{FRAME_HEADER_BYTES, Frame, FrameDecoder, FrameKind, encode_frame};
pub use handshake::{ClientHandshake, PROOF_DOMAIN, mac};
pub use rpc::{
    CallError, Handlers, RPC_CANCEL, RpcError, RpcErrorCode, RpcId, RpcKind, RpcOptions, RpcPeer,
    classify, is_cancel_params,
};
#[cfg(windows)]
pub use transport::NamedPipeTransport;
pub use transport::{Transport, open_transport};

/// 本机通道协议域标识。
pub const PROTOCOL_VERSION: &str = PROOF_DOMAIN;

#[cfg(test)]
mod tests;
