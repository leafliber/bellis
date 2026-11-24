//! 帧环与音频环的错误类型。

use std::fmt;
use std::io;

/// 打开帧环失败（`frame_ring.attach` 映射为 `-32002`）。
#[derive(Debug)]
pub enum FrameRingError {
    InvalidParams(String),
    Open {
        name: String,
        source: io::Error,
    },
    Mismatch {
        field: &'static str,
        header: u64,
        expected: u64,
    },
}

impl fmt::Display for FrameRingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidParams(reason) => write!(f, "invalid frame ring parameters: {reason}"),
            Self::Open { name, source } => {
                write!(f, "cannot open shared memory {name:?}: {source}")
            }
            Self::Mismatch {
                field,
                header,
                expected,
            } => write!(
                f,
                "frame ring header {field} is {header}, the parameters say {expected}"
            ),
        }
    }
}

impl std::error::Error for FrameRingError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Open { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// 写帧失败；帧环不受影响。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameWriteError {
    TooLarge {
        width: u32,
        height: u32,
        max_width: u32,
        max_height: u32,
    },
    InvalidFrame(&'static str),
}

impl fmt::Display for FrameWriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge {
                width,
                height,
                max_width,
                max_height,
            } => write!(
                f,
                "a {width}x{height} frame does not fit a {max_width}x{max_height} frame ring"
            ),
            Self::InvalidFrame(reason) => write!(f, "invalid frame: {reason}"),
        }
    }
}

impl std::error::Error for FrameWriteError {}

/// 打开音频环失败（`audio_ring.attach` 映射为 `-32005`）。
#[derive(Debug)]
pub enum AudioRingError {
    InvalidParams(String),
    Open {
        name: String,
        source: io::Error,
    },
    Mismatch {
        field: &'static str,
        header: u64,
        expected: u64,
    },
}

impl fmt::Display for AudioRingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidParams(reason) => write!(f, "invalid audio ring parameters: {reason}"),
            Self::Open { name, source } => {
                write!(f, "cannot open shared memory {name:?}: {source}")
            }
            Self::Mismatch {
                field,
                header,
                expected,
            } => write!(
                f,
                "audio ring header {field} is {header}, the parameters say {expected}"
            ),
        }
    }
}

impl std::error::Error for AudioRingError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Open { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// 写音频包失败；音频环不受影响。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AudioWriteError {
    InvalidPacket(String),
}

impl fmt::Display for AudioWriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPacket(reason) => write!(f, "invalid audio packet: {reason}"),
        }
    }
}

impl std::error::Error for AudioWriteError {}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FrameReadError {
    Corrupt(String),
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AudioReadError {
    Corrupt(String),
}
