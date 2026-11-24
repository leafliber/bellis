//! 游戏声音采集：音频源接口、WASAPI 进程回环与音频主循环。

pub mod pipeline;
pub mod wasapi;

pub use pipeline::{Audio, AudioStatus, AudioStopped, AudioTargetError, AudioThread};
pub use wasapi::ProcessLoopback;

use std::fmt;
use std::time::Duration;

/// 一个 F32 样本值的字节数。
pub const BYTES_PER_VALUE: u32 = 4;

/// 音频源交出的采样格式：32 位浮点（本机字节序）、各声道交错排列。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u32,
}

impl AudioFormat {
    #[must_use]
    pub fn bytes_per_sample(&self) -> usize {
        self.channels as usize * BYTES_PER_VALUE as usize
    }

    #[must_use]
    pub fn duration_ns(&self, samples: u64) -> u64 {
        if self.sample_rate == 0 {
            return 0;
        }
        let ns = u128::from(samples) * 1_000_000_000 / u128::from(self.sample_rate);
        u64::try_from(ns).unwrap_or(u64::MAX)
    }
}

impl fmt::Display for AudioFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} Hz, {} channel(s), f32",
            self.sample_rate, self.channels
        )
    }
}

/// 一个连续采样点音频包。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioPacket {
    pub capture_ns: u64,
    pub sample_count: u32,
    pub data: Vec<u8>,
    pub discontinuity: bool,
}

/// 音频源：按顺序交出每一个包。
pub trait AudioSource {
    /// 等待下一个包并写入 `packet`，复用其缓冲。
    ///
    /// # Errors
    ///
    /// 见 [`AudioError`]。返回错误后须重建音频源。
    fn next_packet(
        &mut self,
        timeout: Duration,
        packet: &mut AudioPacket,
    ) -> Result<bool, AudioError>;
}

/// 采集声音失败的原因。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AudioError {
    ProcessExited,
    Unsupported(String),
    Os {
        context: &'static str,
        code: i32,
        message: String,
    },
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProcessExited => f.write_str("the target process has exited"),
            Self::Unsupported(what) => write!(f, "unsupported: {what}"),
            Self::Os {
                context,
                code,
                message,
            } => write!(f, "{context} failed (0x{code:08X}): {message}"),
        }
    }
}

impl std::error::Error for AudioError {}

#[cfg(test)]
mod tests {
    use super::AudioFormat;

    #[test]
    fn sample_bytes_and_duration_ns() {
        let stereo = AudioFormat {
            sample_rate: 48_000,
            channels: 2,
        };
        assert_eq!(stereo.bytes_per_sample(), 8);
        assert_eq!(stereo.duration_ns(480), 10_000_000);
        assert_eq!(stereo.duration_ns(1), 20_833);
    }
}
