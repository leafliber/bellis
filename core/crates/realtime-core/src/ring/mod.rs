//! 共享内存 seqlock 帧环与音频环（单写者多读者，零填充 `#[repr(C)]` 头部）。

pub mod audio;
pub mod error;
pub mod frame;
pub mod layout;

pub use audio::{AudioRingWriter, BlockMeta};
pub use error::{AudioRingError, AudioWriteError, FrameRingError, FrameWriteError};
pub use frame::{FrameRingWriter, SlotMeta};

#[cfg(test)]
mod tests;
