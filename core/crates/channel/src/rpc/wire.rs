//! JSON-RPC 2.0 错误类型、消息分类与信封编码。
//!
//! Bellis V2 兼容单段及多段小写方法名（如 `health`、`shutdown`、`lease.renew`），
//! 仍拒绝大写、空格、空段、下划线开头或 `rpc.` 保留前缀的用户处理器。

use std::fmt::{self, Write as _};

use serde_json::{Map, Value};

use crate::error::ChannelError;
use crate::json;

pub const RPC_CANCEL: &str = "rpc.cancel";

/// JSON-RPC 2.0 预定义错误码，以及保留区间内的通用错误码。
pub struct RpcErrorCode;

impl RpcErrorCode {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// 正在处理的请求已达上限。
    pub const SERVER_BUSY: i64 = -32000;
}

/// 对端返回的 JSON-RPC 错误；处理函数返回它即可指定错误码。
#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    #[must_use]
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RPC 错误 {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// 请求失败：通道错误（超时、关闭等），或对端返回的 JSON-RPC 错误。
#[derive(Clone, Debug, PartialEq)]
pub enum CallError {
    Channel(ChannelError),
    Rpc(RpcError),
}

impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Channel(error) => error.fmt(f),
            Self::Rpc(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for CallError {}

impl From<ChannelError> for CallError {
    fn from(error: ChannelError) -> Self {
        Self::Channel(error)
    }
}

/// 规范化后的请求 id。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RpcId {
    Int(i64),
    Str(String),
}

impl RpcId {
    fn to_json(&self) -> String {
        match self {
            Self::Int(id) => id.to_string(),
            Self::Str(id) => json::string_literal(id),
        }
    }
}

const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

fn integer(value: &Value) -> Option<f64> {
    let number = value.as_number()?;
    if let Some(n) = number.as_i64() {
        #[allow(clippy::cast_precision_loss)]
        return Some(n as f64);
    }
    if let Some(n) = number.as_u64() {
        #[allow(clippy::cast_precision_loss)]
        return Some(n as f64);
    }
    number
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0)
}

pub(super) fn rpc_id(value: &Value) -> Option<RpcId> {
    if let Some(text) = value.as_str() {
        let count = text.chars().count();
        return (1..=128)
            .contains(&count)
            .then(|| RpcId::Str(text.to_owned()));
    }
    if let Some(n) = value.as_i64() {
        return (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER)
            .contains(&n)
            .then_some(RpcId::Int(n));
    }
    if value.is_u64() {
        return None;
    }
    let n = integer(value)?;
    #[allow(clippy::cast_precision_loss)]
    let limit = MAX_SAFE_INTEGER as f64;
    #[allow(clippy::cast_possible_truncation)]
    (-limit..=limit)
        .contains(&n)
        .then_some(RpcId::Int(n as i64))
}

fn is_method(value: &Value) -> bool {
    let Some(method) = value.as_str() else {
        return false;
    };
    let mut segments = 0;
    for segment in method.split('.') {
        let bytes = segment.as_bytes();
        let ok = !bytes.is_empty()
            && bytes[0].is_ascii_lowercase()
            && bytes[1..]
                .iter()
                .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_');
        if !ok {
            return false;
        }
        segments += 1;
    }
    segments >= 1
}

fn fields<'a>(
    message: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Option<&'a Map<String, Value>> {
    let fields = message.as_object()?;
    let complete = required.iter().all(|key| fields.contains_key(*key));
    let known = fields
        .keys()
        .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()));
    (complete && known && fields["jsonrpc"] == "2.0").then_some(fields)
}

fn params_ok(fields: &Map<String, Value>) -> bool {
    fields.get("params").is_none_or(Value::is_object)
}

pub(super) fn error_object(value: &Value) -> Option<(i64, &str, Option<&Value>)> {
    let fields = value.as_object()?;
    let known = fields
        .keys()
        .all(|key| matches!(key.as_str(), "code" | "message" | "data"));
    let code = integer(fields.get("code")?)?;
    let message = fields.get("message")?.as_str()?;
    #[allow(clippy::cast_possible_truncation)]
    known.then_some((code as i64, message, fields.get("data")))
}

/// 消息的类别。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RpcKind {
    Request,
    Notification,
    Success,
    Failure,
    Invalid,
}

/// 判断 JSON-RPC 2.0 消息类别。
#[must_use]
pub fn classify(message: &Value) -> RpcKind {
    if fields(message, &["jsonrpc", "id", "method"], &["params"])
        .is_some_and(|f| rpc_id(&f["id"]).is_some() && is_method(&f["method"]) && params_ok(f))
    {
        RpcKind::Request
    } else if fields(message, &["jsonrpc", "method"], &["params"])
        .is_some_and(|f| is_method(&f["method"]) && params_ok(f))
    {
        RpcKind::Notification
    } else if fields(message, &["jsonrpc", "id", "result"], &[])
        .is_some_and(|f| rpc_id(&f["id"]).is_some())
    {
        RpcKind::Success
    } else if fields(message, &["jsonrpc", "id", "error"], &[]).is_some_and(|f| {
        (f["id"].is_null() || rpc_id(&f["id"]).is_some()) && error_object(&f["error"]).is_some()
    }) {
        RpcKind::Failure
    } else {
        RpcKind::Invalid
    }
}

/// `rpc.cancel` 的参数是否恰为 `{"id": <合法 id>}`。
#[must_use]
pub fn is_cancel_params(params: &Value) -> bool {
    params
        .as_object()
        .is_some_and(|f| f.len() == 1 && f.get("id").and_then(rpc_id).is_some())
}

fn with_params(mut head: String, params: Option<&Map<String, Value>>) -> Vec<u8> {
    if let Some(params) = params {
        head.push_str(r#","params":"#);
        head.push_str(&Value::Object(params.clone()).to_string());
    }
    head.push('}');
    head.into_bytes()
}

pub(super) fn request_envelope(
    id: i64,
    method: &str,
    params: Option<&Map<String, Value>>,
) -> Vec<u8> {
    let head = format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":{}"#,
        json::string_literal(method)
    );
    with_params(head, params)
}

pub(super) fn notification_envelope(method: &str, params: Option<&Map<String, Value>>) -> Vec<u8> {
    let head = format!(
        r#"{{"jsonrpc":"2.0","method":{}"#,
        json::string_literal(method)
    );
    with_params(head, params)
}

pub(super) fn success_envelope(id: &RpcId, result: &Value) -> Vec<u8> {
    format!(
        r#"{{"jsonrpc":"2.0","id":{},"result":{result}}}"#,
        id.to_json()
    )
    .into_bytes()
}

pub(super) fn failure_envelope(id: Option<&RpcId>, error: &RpcError) -> Vec<u8> {
    let id = id.map_or_else(|| "null".to_owned(), RpcId::to_json);
    let mut body = format!(
        r#"{{"code":{},"message":{}"#,
        error.code,
        json::string_literal(&error.message)
    );
    if let Some(data) = &error.data {
        let _ = write!(body, r#","data":{data}"#);
    }
    format!(r#"{{"jsonrpc":"2.0","id":{id},"error":{body}}}}}"#).into_bytes()
}
