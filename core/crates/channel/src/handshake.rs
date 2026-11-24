//! 握手：双向 HMAC-SHA256 认证。不做 IO。
//!
//! 客户端发 hello（角色 + 随机数）；服务端回 challenge（随机数 + 证明）；客户端核验服务端证明后才回送
//! 自己的证明；服务端核验后回 accept。证明为
//! `HMAC-SHA256(会话密钥, JSON.stringify([域, 方向, 角色, 客户端随机数, 服务端随机数]))`，
//! base64url 无填充，域为 `bellis-channel/1`，方向为 `server` 或 `client`。

use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value};
use sha2::Sha256;

use crate::address::SessionKey;
use crate::base64url;
use crate::error::{ChannelError, ErrorCode};
use crate::frame::{Frame, FrameKind, encode_frame};
use crate::json;

pub const PROOF_DOMAIN: &str = "bellis-channel/1";
pub(crate) const NONCE_BYTES: usize = 32;

/// 握手证明的 HMAC-SHA256。
///
/// # Panics
///
/// 不会 panic：HMAC 接受任意长度的密钥。
#[must_use]
pub fn mac(
    key: &SessionKey,
    domain: &str,
    direction: &str,
    role: &str,
    client_nonce: &str,
    server_nonce: &str,
) -> [u8; 32] {
    let record = Value::from(vec![domain, direction, role, client_nonce, server_nonce]);
    let mut hmac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC 接受任意长度的密钥");
    hmac.update(&json::dumps(&record));
    hmac.finalize().into_bytes().into()
}

/// 角色名：`^[a-z][a-z0-9_.:-]{0,63}$`。
pub(crate) fn is_valid_role(role: &str) -> bool {
    let bytes = role.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|&c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'_' | b'.' | b':' | b'-')
        })
}

fn is_version(value: &Value) -> bool {
    value.as_f64() == Some(1.0)
}

fn bytes32(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|text| base64url::is_bytes32_text(text))
}

fn closed_object<'a>(
    message: &'a Value,
    kind: &str,
    keys: &[&str],
) -> Option<&'a Map<String, Value>> {
    let fields = message.as_object()?;
    let exact = fields.len() == keys.len() && keys.iter().all(|key| fields.contains_key(*key));
    (exact && is_version(&fields["v"]) && fields["type"] == kind).then_some(fields)
}

pub(crate) fn parse_challenge(message: &Value) -> Option<(&str, &str)> {
    let fields = closed_object(message, "challenge", &["v", "type", "nonce", "proof"])?;
    Some((bytes32(&fields["nonce"])?, bytes32(&fields["proof"])?))
}

pub(crate) fn is_accept(message: &Value) -> bool {
    closed_object(message, "accept", &["v", "type"]).is_some()
}

fn handshake_message(frame: &Frame) -> Result<Value, ChannelError> {
    if frame.kind != FrameKind::Handshake {
        return Err(ChannelError::new(
            ErrorCode::ProtocolError,
            "认证完成前收到业务数据",
        ));
    }
    json::loads(&frame.payload, "握手消息")
}

fn invalid(expected: &str) -> ChannelError {
    ChannelError::new(
        ErrorCode::ProtocolError,
        format!("握手消息不合法，期望 {expected}"),
    )
}

/// 常量时间比较证明。
fn verify(proof: &str, expected: &[u8; 32]) -> bool {
    let Some(actual) = base64url::decode_bytes32(proof) else {
        return false;
    };
    actual
        .iter()
        .zip(expected)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// 客户端一侧的握手：`hello()` → `on_challenge()` → `on_accept()`，任一步失败即返回错误。
pub struct ClientHandshake {
    key: SessionKey,
    role: String,
    nonce: String,
}

impl ClientHandshake {
    /// # Errors
    ///
    /// 角色名不合法时为 `protocol-error`，此时不应发起连接。
    pub fn new(
        key: &SessionKey,
        role: &str,
        nonce: &[u8; NONCE_BYTES],
    ) -> Result<Self, ChannelError> {
        if !is_valid_role(role) {
            return Err(ChannelError::new(
                ErrorCode::ProtocolError,
                format!("角色名不合法：{role}"),
            ));
        }
        Ok(Self {
            key: *key,
            role: role.to_owned(),
            nonce: base64url::encode(nonce),
        })
    }

    #[must_use]
    pub fn role(&self) -> &str {
        &self.role
    }

    /// hello 帧。角色与随机数都只含 JSON 无须转义的字符。
    #[must_use]
    pub fn hello(&self) -> Vec<u8> {
        let message = format!(
            r#"{{"v":1,"type":"hello","role":"{}","nonce":"{}"}}"#,
            self.role, self.nonce
        );
        encode_frame(FrameKind::Handshake, message.as_bytes())
    }

    /// 核验服务端的证明，返回要发出的 proof 帧。
    ///
    /// # Errors
    ///
    /// 服务端未能证明时为 `auth-failed`；消息不合法时为 `protocol-error`。
    pub fn on_challenge(&self, frame: &Frame) -> Result<Vec<u8>, ChannelError> {
        let message = handshake_message(frame)?;
        let (server_nonce, proof) =
            parse_challenge(&message).ok_or_else(|| invalid("challenge"))?;
        let expected = mac(
            &self.key,
            PROOF_DOMAIN,
            "server",
            &self.role,
            &self.nonce,
            server_nonce,
        );
        if !verify(proof, &expected) {
            return Err(ChannelError::new(
                ErrorCode::AuthFailed,
                "服务端未能证明持有会话密钥，地址可能被抢注",
            ));
        }
        let own = base64url::encode(&mac(
            &self.key,
            PROOF_DOMAIN,
            "client",
            &self.role,
            &self.nonce,
            server_nonce,
        ));
        let message = format!(r#"{{"v":1,"type":"proof","proof":"{own}"}}"#);
        Ok(encode_frame(FrameKind::Handshake, message.as_bytes()))
    }

    /// # Errors
    ///
    /// accept 不合法时为 `protocol-error`。
    pub fn on_accept(&self, frame: &Frame) -> Result<(), ChannelError> {
        if is_accept(&handshake_message(frame)?) {
            Ok(())
        } else {
            Err(invalid("accept"))
        }
    }
}

#[cfg(test)]
pub(crate) fn parse_hello(message: &Value) -> Option<(&str, &str)> {
    let fields = closed_object(message, "hello", &["v", "type", "role", "nonce"])?;
    let role = fields["role"].as_str().filter(|role| is_valid_role(role))?;
    Some((role, bytes32(&fields["nonce"])?))
}

#[cfg(test)]
pub(crate) fn parse_proof(message: &Value) -> Option<&str> {
    let fields = closed_object(message, "proof", &["v", "type", "proof"])?;
    bytes32(&fields["proof"])
}
