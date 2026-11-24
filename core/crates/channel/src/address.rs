//! 本次会话的通道地址与会话密钥。

use std::fmt;
use std::path::Path;

use crate::base64url;
use crate::error::{ChannelError, ErrorCode};

pub const SESSION_KEY_BYTES: usize = 32;
pub const MAX_UDS_PATH_BYTES: usize = 103;

/// 本次会话的共享密钥。
pub type SessionKey = [u8; SESSION_KEY_BYTES];

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// RFC 4648 base32，小写、无填充。
fn base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut bits = 0u32;
    let mut value = 0u32;
    for &byte in bytes {
        value = ((value << 8) | u32::from(byte)) & 0xffff;
        bits += 8;
        while bits >= 5 {
            out.push(char::from(BASE32[((value >> (bits - 5)) & 31) as usize]));
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(char::from(BASE32[((value << (5 - bits)) & 31) as usize]));
    }
    out
}

fn is_session_id(session_id: &str) -> bool {
    (1..=16).contains(&session_id.len())
        && session_id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// `bellis-<会话编号>-<random 的 base32>`。
///
/// # Errors
///
/// 会话编号不匹配 `^[a-z0-9]{1,16}$` 时为 `address-invalid`。
pub fn channel_name(session_id: &str, random: &[u8; 16]) -> Result<String, ChannelError> {
    if !is_session_id(session_id) {
        return Err(ChannelError::new(
            ErrorCode::AddressInvalid,
            "会话编号须匹配 ^[a-z0-9]{1,16}$",
        ));
    }
    Ok(format!("bellis-{session_id}-{}", base32(random)))
}

/// 生成通道地址：Windows 上为命名管道 `\\.\pipe\<名字>`，忽略 `directory`。
///
/// # Errors
///
/// 会话编号不合法或 UDS 路径超过 103 字节时为 `address-invalid`。
pub fn create_channel_path(session_id: &str, directory: &Path) -> Result<String, ChannelError> {
    let mut random = [0u8; 16];
    fill_random(&mut random);
    let name = channel_name(session_id, &random)?;
    if cfg!(windows) {
        let _ = directory;
        return Ok(format!(r"\\.\pipe\{name}"));
    }
    let path = directory.join(format!("{name}.sock"));
    let text = path.to_string_lossy().into_owned();
    if text.len() > MAX_UDS_PATH_BYTES {
        return Err(ChannelError::new(
            ErrorCode::AddressInvalid,
            format!("UDS 路径超过 {MAX_UDS_PATH_BYTES} 字节：{text}"),
        ));
    }
    Ok(text)
}

/// 以系统随机数填满 `buffer`。
///
/// # Panics
///
/// 系统随机数源不可用时 panic。
pub(crate) fn fill_random(buffer: &mut [u8]) {
    getrandom::fill(buffer).expect("系统随机数源不可用");
}

/// 生成 32 字节的会话密钥。
///
/// # Panics
///
/// 系统随机数源不可用时 panic。
#[must_use]
pub fn create_session_key() -> SessionKey {
    let mut key = [0u8; SESSION_KEY_BYTES];
    fill_random(&mut key);
    key
}

#[must_use]
pub fn encode_session_key(key: &SessionKey) -> String {
    base64url::encode(key)
}

/// 只接受 32 字节密钥的规范 base64url（无填充）编码。
///
/// # Errors
///
/// 格式不对时为 `address-invalid`。
pub fn decode_session_key(text: &str) -> Result<SessionKey, ChannelError> {
    base64url::decode_bytes32(text)
        .filter(|key| base64url::encode(key) == text)
        .ok_or_else(|| ChannelError::new(ErrorCode::AddressInvalid, "会话密钥格式不正确"))
}

/// 通道地址与会话密钥。
#[derive(Clone, PartialEq, Eq)]
pub struct ChannelCredentials {
    pub path: String,
    pub key: SessionKey,
}

impl ChannelCredentials {
    /// 从地址与 base64url 编码的密钥构造。
    ///
    /// # Errors
    ///
    /// 密钥格式不对时为 `address-invalid`。
    pub fn decode(path: impl Into<String>, encoded_key: &str) -> Result<Self, ChannelError> {
        Ok(Self {
            path: path.into(),
            key: decode_session_key(encoded_key)?,
        })
    }

    #[must_use]
    pub fn encoded_key(&self) -> String {
        encode_session_key(&self.key)
    }
}

impl fmt::Debug for ChannelCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChannelCredentials")
            .field("path", &self.path)
            .field("key", &"<redacted>")
            .finish()
    }
}
