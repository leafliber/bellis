//! JSON 负载的解析与紧凑编码。

use serde_json::Value;

use crate::error::{ChannelError, ErrorCode};

/// 解析一帧 JSON 负载；`what` 用于错误说明。
pub(crate) fn loads(payload: &[u8], what: &str) -> Result<Value, ChannelError> {
    let text = String::from_utf8_lossy(payload);
    serde_json::from_str(&text).map_err(|error| {
        ChannelError::new(
            ErrorCode::ProtocolError,
            format!("{what}不是合法 JSON：{error}"),
        )
    })
}

/// 把一个 JSON 值编码为紧凑的 UTF-8。
pub(crate) fn dumps(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

/// 把字符串编码为 JSON 字符串字面量。
pub(crate) fn string_literal(text: &str) -> String {
    Value::from(text).to_string()
}
