//! 帧编解码：4 字节大端负载长度 + 1 字节类型（0 握手、1 JSON、2 二进制）+ 负载。

use crate::error::{ChannelError, ErrorCode};

pub const FRAME_HEADER_BYTES: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameKind {
    Handshake = 0,
    Json = 1,
    Binary = 2,
}

impl FrameKind {
    fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            0 => Some(Self::Handshake),
            1 => Some(Self::Json),
            2 => Some(Self::Binary),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub kind: FrameKind,
    pub payload: Vec<u8>,
}

/// 编码一帧。
///
/// # Panics
///
/// 负载超过 `u32::MAX` 字节时 panic；调用方都先按帧长上限检查过。
#[must_use]
pub fn encode_frame(kind: FrameKind, payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len()).expect("帧负载超过 u32 范围");
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.push(kind as u8);
    frame.extend_from_slice(payload);
    frame
}

/// 解析帧头，返回类型与负载长度。
///
/// # Errors
///
/// 类型未知时为 `protocol-error`，超过 `max_payload_bytes` 时为 `frame-too-large`。
pub(crate) fn parse_header(
    header: [u8; FRAME_HEADER_BYTES],
    max_payload_bytes: usize,
) -> Result<(FrameKind, usize), ChannelError> {
    let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    let kind = FrameKind::from_byte(header[4]).ok_or_else(|| {
        ChannelError::new(
            ErrorCode::ProtocolError,
            format!("未知的帧类型 {}", header[4]),
        )
    })?;
    let length = usize::try_from(length).unwrap_or(usize::MAX);
    if length > max_payload_bytes {
        return Err(ChannelError::new(
            ErrorCode::FrameTooLarge,
            format!("帧长 {length} 超过上限 {max_payload_bytes}"),
        ));
    }
    Ok((kind, length))
}

/// 增量解帧。每次 `read()` 只取一帧，调用方可以在两帧之间调整长度上限。
#[derive(Debug)]
pub struct FrameDecoder {
    max_payload_bytes: usize,
    buffer: Vec<u8>,
}

impl FrameDecoder {
    #[must_use]
    pub fn new(max_payload_bytes: usize) -> Self {
        Self {
            max_payload_bytes,
            buffer: Vec::new(),
        }
    }

    pub fn set_max_payload_bytes(&mut self, value: usize) {
        self.max_payload_bytes = value;
    }

    #[must_use]
    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// 取出下一帧；数据不足时返回 `Ok(None)`。
    ///
    /// # Errors
    ///
    /// 帧头非法时返回 `protocol-error` 或 `frame-too-large`。
    pub fn read(&mut self) -> Result<Option<Frame>, ChannelError> {
        let Some(header) = self.buffer.first_chunk::<FRAME_HEADER_BYTES>() else {
            return Ok(None);
        };
        let (kind, length) = parse_header(*header, self.max_payload_bytes)?;
        let end = FRAME_HEADER_BYTES + length;
        if self.buffer.len() < end {
            return Ok(None);
        }
        let payload = self.buffer[FRAME_HEADER_BYTES..end].to_vec();
        self.buffer.drain(..end);
        Ok(Some(Frame { kind, payload }))
    }
}
