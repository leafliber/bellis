//! 画面采集：采集源接口、几何裁剪、窗口识别、Windows Graphics Capture（WGC）与采集主循环。

pub mod dpi;
pub mod geometry;
pub mod pipeline;
pub mod selector;
pub mod wgc;
mod wgc_support;
pub mod window;

pub use geometry::{
    CropBox, CropError, Point, Rect, Size, Transform, TransformTracker, WindowGeometry, client_crop,
};
pub use pipeline::{Capture, CaptureStopped, CaptureThread, FrameStatus, Geometry, TargetError};
pub use selector::{WindowInfo, WindowSelector};
pub use wgc::{BorderRequest, BorderStatus, WgcCapture, WgcOptions, WgcStats, is_supported};
pub use window::{TopLevelWindow, find_window, list_windows, query_geometry, select_window};

use std::fmt;
use std::time::Duration;

/// BGRA8 每个像素的字节数。
pub const BYTES_PER_PIXEL: u32 = 4;

/// 采集源：每次调用交出最新的一帧，中间积压的旧帧丢弃但帧号照常递增。
pub trait CaptureSource {
    /// 采集源绑定的原生窗口。
    fn window_identity(&self) -> Option<WindowIdentity> {
        None
    }

    /// 等待下一帧并写入 `frame`，复用 `frame` 的像素缓冲。
    ///
    /// # Errors
    ///
    /// 见 [`CaptureError`]。[`CaptureError::is_recoverable`] 为真时可继续调用，否则须重建采集源。
    fn next_frame(&mut self, timeout: Duration, frame: &mut Frame) -> Result<bool, CaptureError>;
}

/// 选中的窗口及其所属进程。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowIdentity {
    pub handle: isize,
    pub process_id: u32,
}

/// 一帧的元数据（坐标与尺寸均为物理像素）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameMeta {
    pub number: u64,
    pub captured_at_ns: u64,
    pub transform_version: u64,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub client_origin: Point,
    pub dpi: u32,
}

/// 一帧：客户区的 BGRA8 像素与元数据。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frame {
    pub meta: FrameMeta,
    pub pixels: Vec<u8>,
}

impl Frame {
    /// 第 `y` 行的有效像素（`width * 4` 字节）；越界时为 `None`。
    #[must_use]
    pub fn row(&self, y: u32) -> Option<&[u8]> {
        if y >= self.meta.height {
            return None;
        }
        let start = usize::try_from(u64::from(y) * u64::from(self.meta.stride)).ok()?;
        let len = usize::try_from(u64::from(self.meta.width) * u64::from(BYTES_PER_PIXEL)).ok()?;
        self.pixels.get(start..start.checked_add(len)?)
    }

    /// `(x, y)` 处的像素（BGRA）；越界时为 `None`。
    #[must_use]
    pub fn pixel(&self, x: u32, y: u32) -> Option<[u8; 4]> {
        if x >= self.meta.width {
            return None;
        }
        let row = self.row(y)?;
        let start = usize::try_from(x).ok()? * BYTES_PER_PIXEL as usize;
        row.get(start..start + BYTES_PER_PIXEL as usize)?
            .try_into()
            .ok()
    }
}

/// 采集失败的原因。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureError {
    WindowNotFound {
        selector: String,
    },
    AmbiguousWindow {
        selector: String,
        matches: usize,
    },
    WindowClosed,
    WindowMinimized,
    ExclusiveFullscreen,
    NotPerMonitorDpiAwareV2,
    Unsupported(&'static str),
    Os {
        context: &'static str,
        code: i32,
        message: String,
    },
}

impl CaptureError {
    /// 该错误后采集源是否仍可继续产出帧。
    #[must_use]
    pub fn is_recoverable(&self) -> bool {
        matches!(self, Self::WindowMinimized | Self::ExclusiveFullscreen)
    }
}

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WindowNotFound { selector } => write!(f, "no window matches {selector}"),
            Self::AmbiguousWindow { selector, matches } => {
                write!(f, "{matches} windows match {selector}; refusing to guess")
            }
            Self::WindowClosed => f.write_str("the captured window was closed"),
            Self::WindowMinimized => f.write_str("the captured window is minimized"),
            Self::ExclusiveFullscreen => {
                f.write_str("the captured window is in exclusive fullscreen, which is unsupported")
            }
            Self::NotPerMonitorDpiAwareV2 => {
                f.write_str("the calling thread is not per-monitor DPI aware v2")
            }
            Self::Unsupported(what) => write!(f, "unsupported: {what}"),
            Self::Os {
                context,
                code,
                message,
            } => write!(f, "{context} failed (0x{code:08X}): {message}"),
        }
    }
}

impl std::error::Error for CaptureError {}

#[allow(clippy::cast_possible_truncation, reason = "Win32 结构远小于 4 GiB")]
pub(crate) const fn byte_size<T>() -> u32 {
    size_of::<T>() as u32
}

pub(crate) fn os_error(context: &'static str) -> impl FnOnce(windows::core::Error) -> CaptureError {
    move |error| CaptureError::Os {
        context,
        code: error.code().0,
        message: error.message(),
    }
}

#[cfg(test)]
mod tests {
    use super::{Frame, FrameMeta, Point};

    #[test]
    fn row_and_pixel_honor_stride_and_bounds() {
        let mut pixels = vec![0xEE; 24];
        for y in 0..2u8 {
            for x in 0..2u8 {
                let at = usize::from(y) * 12 + usize::from(x) * 4;
                pixels[at..at + 4].copy_from_slice(&[10 * y + x, 1, 2, 255]);
            }
        }
        let frame = Frame {
            meta: FrameMeta {
                number: 1,
                captured_at_ns: 1_000,
                transform_version: 1,
                width: 2,
                height: 2,
                stride: 12,
                client_origin: Point { x: -5, y: 7 },
                dpi: 144,
            },
            pixels,
        };
        assert_eq!(frame.row(0), Some(&[0, 1, 2, 255, 1, 1, 2, 255][..]));
        assert_eq!(frame.pixel(1, 1), Some([11, 1, 2, 255]));
        assert_eq!(frame.pixel(2, 0), None);
        assert_eq!(frame.row(2), None);
    }
}
