//! 客户区裁剪与变换版本。坐标一律是屏幕物理像素。

use std::fmt;

/// 一个点。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// 宽与高。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

impl fmt::Display for Size {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}x{}", self.width, self.height)
    }
}

/// 矩形，含左上、不含右下。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    #[must_use]
    pub fn origin(&self) -> Point {
        Point {
            x: self.left,
            y: self.top,
        }
    }

    #[must_use]
    pub fn size(&self) -> Size {
        Size {
            width: span(self.left, self.right),
            height: span(self.top, self.bottom),
        }
    }

    #[must_use]
    pub fn contains(&self, inner: &Rect) -> bool {
        inner.left >= self.left
            && inner.top >= self.top
            && inner.right <= self.right
            && inner.bottom <= self.bottom
    }
}

fn span(start: i32, end: i32) -> u32 {
    u32::try_from(i64::from(end) - i64::from(start)).unwrap_or(0)
}

/// 某一时刻窗口在屏幕上的几何。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WindowGeometry {
    /// DWM 窗口边界（`DWMWA_EXTENDED_FRAME_BOUNDS`）。
    pub frame_bounds: Rect,
    /// 客户区在屏幕上的范围。
    pub client: Rect,
    /// 客户区所在显示器的有效 DPI。
    pub dpi: u32,
}

impl WindowGeometry {
    #[must_use]
    pub fn transform(&self) -> Transform {
        Transform {
            client_origin: self.client.origin(),
            client_size: self.client.size(),
            dpi: self.dpi,
        }
    }
}

/// 客户区在 WGC 画面中的裁剪框。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CropBox {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// 无法从一帧中裁出客户区的原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CropError {
    StaleContent { content: Size, bounds: Size },
    ClientOutsideBounds,
    EmptyClient,
}

/// 从尺寸为 `content` 的 WGC 窗口画面中裁出客户区。
///
/// # Errors
///
/// 画面尺寸与 DWM 窗口边界不匹配、客户区超出边界或为空时返回 [`CropError`]。
pub fn client_crop(geometry: &WindowGeometry, content: Size) -> Result<CropBox, CropError> {
    let bounds = geometry.frame_bounds.size();
    if content != bounds {
        return Err(CropError::StaleContent { content, bounds });
    }
    if !geometry.frame_bounds.contains(&geometry.client) {
        return Err(CropError::ClientOutsideBounds);
    }
    let size = geometry.client.size();
    if size.width == 0 || size.height == 0 {
        return Err(CropError::EmptyClient);
    }
    Ok(CropBox {
        x: span(geometry.frame_bounds.left, geometry.client.left),
        y: span(geometry.frame_bounds.top, geometry.client.top),
        width: size.width,
        height: size.height,
    })
}

/// 客户区到屏幕的变换：客户区原点、尺寸与所在显示器的 DPI。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Transform {
    pub client_origin: Point,
    pub client_size: Size,
    pub dpi: u32,
}

/// 计算窗口与 DPI 变换版本（窗口移动、缩放或 DPI 变化时加一）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TransformTracker {
    last: Option<Transform>,
    version: u64,
}

impl TransformTracker {
    pub fn observe(&mut self, transform: Transform) -> u64 {
        if self.last != Some(transform) {
            self.last = Some(transform);
            self.version += 1;
        }
        self.version
    }

    #[must_use]
    pub fn version(&self) -> u64 {
        self.version
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CropBox, CropError, Point, Rect, Size, Transform, TransformTracker, WindowGeometry,
        client_crop,
    };

    fn rect(left: i32, top: i32, width: i32, height: i32) -> Rect {
        Rect {
            left,
            top,
            right: left + width,
            bottom: top + height,
        }
    }

    fn framed_window() -> WindowGeometry {
        WindowGeometry {
            frame_bounds: rect(100, 200, 816, 639),
            client: rect(101, 231, 814, 607),
            dpi: 96,
        }
    }

    #[test]
    fn crops_client_area_and_rejects_stale_or_invalid_geometry() {
        let geometry = framed_window();
        assert_eq!(
            client_crop(&geometry, geometry.frame_bounds.size()),
            Ok(CropBox {
                x: 1,
                y: 31,
                width: 814,
                height: 607,
            })
        );
        let stale = Size {
            width: 800,
            height: 639,
        };
        assert!(matches!(
            client_crop(&geometry, stale),
            Err(CropError::StaleContent { .. })
        ));
        let mut outside = geometry;
        outside.client.right += 2;
        assert_eq!(
            client_crop(&outside, geometry.frame_bounds.size()),
            Err(CropError::ClientOutsideBounds)
        );
    }

    #[test]
    fn transform_version_counts_changes_only() {
        let mut tracker = TransformTracker::default();
        let base = framed_window().transform();
        assert_eq!(tracker.observe(base), 1);
        assert_eq!(tracker.observe(base), 1);
        let moved = Transform {
            client_origin: Point { x: 140, y: 231 },
            ..base
        };
        assert_eq!(tracker.observe(moved), 2);
        assert_eq!(tracker.version(), 2);
    }
}
