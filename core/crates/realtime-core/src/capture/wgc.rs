//! WGC 采集源：D3D11 staging 纹理读回、自由线程帧池、客户区裁剪、去黄框与尺寸变化重建。

use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::core::{HRESULT, factory};

use super::dpi::thread_is_per_monitor_aware_v2;
use super::wgc_support::{
    Signal, configure_border, create_device, frame_texture, missing, winrt_device,
};
use super::window::{TopLevelWindow, check_capturable, find_window, query_geometry};
use super::{
    BYTES_PER_PIXEL, CaptureError, CaptureSource, CropBox, CropError, Frame, FrameMeta, Size,
    TransformTracker, WindowIdentity, WindowSelector, client_crop, os_error as os,
};
use crate::clock::hundred_ns_to_ns;

const PIXEL_FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
const POOL_BUFFERS: i32 = 2;
const STATE_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// WGC 采集源的配置。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WgcOptions {
    pub selector: WindowSelector,
    pub border: BorderRequest,
    pub min_update_interval: Option<Duration>,
}

/// 黄色采集边框的处理。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BorderRequest {
    #[default]
    Remove,
    Keep,
}

/// 黄色采集边框的设置结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BorderStatus {
    pub request: BorderRequest,
    pub access: Option<String>,
    pub set_error: Option<String>,
    pub border_required: Option<bool>,
}

/// 采集源计数。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WgcStats {
    pub taken: u64,
    pub delivered: u64,
    pub superseded: u64,
    pub stale: u64,
    pub uncroppable: u64,
    pub pool_recreations: u64,
}

struct Staging {
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
}

/// 按窗口采集客户区的 WGC 采集源。在哪个线程创建，就在哪个线程使用。
pub struct WgcCapture {
    window: TopLevelWindow,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt_device: IDirect3DDevice,
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    pool_size: SizeInt32,
    signal: Arc<Signal>,
    frame_arrived_token: i64,
    closed_token: i64,
    staging: Option<Staging>,
    tracker: TransformTracker,
    border: BorderStatus,
    stats: WgcStats,
}

impl WgcCapture {
    /// 找到窗口并开始采集。
    ///
    /// # Errors
    ///
    /// 系统不支持 WGC、线程非 DPI Aware v2、窗口找不到/不唯一/关闭/最小化/独占全屏或系统调用失败时返回错误。
    pub fn new(options: &WgcOptions) -> Result<Self, CaptureError> {
        if !is_supported()? {
            return Err(CaptureError::Unsupported("Windows Graphics Capture"));
        }
        if !thread_is_per_monitor_aware_v2() {
            return Err(CaptureError::NotPerMonitorDpiAwareV2);
        }
        let window = find_window(&options.selector)?;
        check_capturable(window.hwnd)?;

        let (device, context) = create_device()?;
        let winrt_device = winrt_device(&device)?;
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(os("IGraphicsCaptureItemInterop"))?;
        // SAFETY: 句柄来自刚才的枚举；若已关闭系统返回错误而非越界访问。
        let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(window.hwnd) }
            .map_err(os("IGraphicsCaptureItemInterop::CreateForWindow"))?;
        let pool_size = item.Size().map_err(os("GraphicsCaptureItem::Size"))?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            PIXEL_FORMAT,
            POOL_BUFFERS,
            pool_size,
        )
        .map_err(os("Direct3D11CaptureFramePool::CreateFreeThreaded"))?;
        let session = pool
            .CreateCaptureSession(&item)
            .map_err(os("Direct3D11CaptureFramePool::CreateCaptureSession"))?;
        session
            .SetIsCursorCaptureEnabled(false)
            .map_err(os("GraphicsCaptureSession::SetIsCursorCaptureEnabled"))?;
        let border = configure_border(&session, options.border);
        if let Some(interval) = options.min_update_interval {
            let hundred_ns = i64::try_from(interval.as_nanos() / 100).unwrap_or(i64::MAX);
            session
                .SetMinUpdateInterval(TimeSpan {
                    Duration: hundred_ns,
                })
                .map_err(os("GraphicsCaptureSession::SetMinUpdateInterval"))?;
        }

        let signal = Arc::new(Signal::default());
        let on_frame = Arc::clone(&signal);
        let frame_arrived_token = pool
            .FrameArrived(&TypedEventHandler::new(move |_, _| {
                on_frame.frame_arrived();
                Ok(())
            }))
            .map_err(os("Direct3D11CaptureFramePool::FrameArrived"))?;
        let on_closed = Arc::clone(&signal);
        let closed_token = item
            .Closed(&TypedEventHandler::new(move |_, _| {
                on_closed.item_closed();
                Ok(())
            }))
            .map_err(os("GraphicsCaptureItem::Closed"))?;

        let capture = Self {
            window,
            device,
            context,
            winrt_device,
            item,
            pool,
            session,
            pool_size,
            signal,
            frame_arrived_token,
            closed_token,
            staging: None,
            tracker: TransformTracker::default(),
            border,
            stats: WgcStats::default(),
        };
        capture
            .session
            .StartCapture()
            .map_err(os("GraphicsCaptureSession::StartCapture"))?;
        Ok(capture)
    }

    #[must_use]
    pub fn window(&self) -> &TopLevelWindow {
        &self.window
    }

    #[must_use]
    pub fn border(&self) -> &BorderStatus {
        &self.border
    }

    #[must_use]
    pub fn stats(&self) -> WgcStats {
        self.stats
    }

    fn take_latest(&mut self) -> Result<Option<Direct3D11CaptureFrame>, CaptureError> {
        let mut latest: Option<Direct3D11CaptureFrame> = None;
        loop {
            match self.pool.TryGetNextFrame() {
                Ok(frame) => {
                    self.stats.taken += 1;
                    if let Some(older) = latest.replace(frame) {
                        let _ = older.Close();
                        self.stats.superseded += 1;
                    }
                }
                Err(error) if error.code() == HRESULT(0) => return Ok(latest),
                Err(error) => return Err(os("Direct3D11CaptureFramePool::TryGetNextFrame")(error)),
            }
        }
    }

    fn read_client(
        &mut self,
        wgc_frame: &Direct3D11CaptureFrame,
        content: SizeInt32,
        out: &mut Frame,
    ) -> Result<bool, CaptureError> {
        let number = self.stats.taken;
        let relative_time = wgc_frame
            .SystemRelativeTime()
            .map_err(os("Direct3D11CaptureFrame::SystemRelativeTime"))?;
        let captured_at_ns = hundred_ns_to_ns(relative_time.Duration).ok_or(CaptureError::Os {
            context: "Direct3D11CaptureFrame::SystemRelativeTime",
            code: 0,
            message: format!("out of range: {}", relative_time.Duration),
        })?;
        let texture = frame_texture(wgc_frame)?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: 只写入局部描述结构。
        unsafe { texture.GetDesc(&raw mut desc) };
        let content = Size {
            width: u32::try_from(content.Width).unwrap_or(0),
            height: u32::try_from(content.Height).unwrap_or(0),
        };
        if content.width > desc.Width || content.height > desc.Height {
            self.stats.stale += 1;
            return Ok(false);
        }

        let geometry = query_geometry(self.window.hwnd)?;
        let crop = match client_crop(&geometry, content) {
            Ok(crop) => crop,
            Err(CropError::StaleContent { .. }) => {
                self.stats.stale += 1;
                return Ok(false);
            }
            Err(CropError::ClientOutsideBounds | CropError::EmptyClient) => {
                self.stats.uncroppable += 1;
                return Ok(false);
            }
        };
        self.copy_out(&texture, crop, out)?;

        let transform = geometry.transform();
        out.meta = FrameMeta {
            number,
            captured_at_ns,
            transform_version: self.tracker.observe(transform),
            width: crop.width,
            height: crop.height,
            stride: crop.width * BYTES_PER_PIXEL,
            client_origin: transform.client_origin,
            dpi: transform.dpi,
        };
        self.stats.delivered += 1;
        Ok(true)
    }

    fn copy_out(
        &mut self,
        texture: &ID3D11Texture2D,
        crop: CropBox,
        out: &mut Frame,
    ) -> Result<(), CaptureError> {
        let staging = self.staging(crop.width, crop.height)?;
        let source_box = D3D11_BOX {
            left: crop.x,
            top: crop.y,
            front: 0,
            right: crop.x + crop.width,
            bottom: crop.y + crop.height,
            back: 1,
        };
        // SAFETY: 源框在纹理内，目标 staging 纹理同格式同尺寸。
        unsafe {
            self.context.CopySubresourceRegion(
                &staging,
                0,
                0,
                0,
                0,
                texture,
                0,
                Some(&raw const source_box),
            );
        }
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: staging 纹理允许 CPU 读取，映射结果写入局部变量。
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&raw mut mapped))
        }
        .map_err(os("ID3D11DeviceContext::Map"))?;

        let row_bytes = crop.width as usize * BYTES_PER_PIXEL as usize;
        let rows = crop.height as usize;
        let pitch = mapped.RowPitch as usize;
        out.pixels.resize(row_bytes * rows, 0);
        let source = mapped.pData.cast::<u8>().cast_const();
        for (y, row) in out.pixels.chunks_exact_mut(row_bytes).enumerate() {
            // SAFETY: 映射内存含 `rows` 行、每行 `pitch >= row_bytes`，Unmap 前有效。
            let line = unsafe { std::slice::from_raw_parts(source.add(y * pitch), row_bytes) };
            row.copy_from_slice(line);
        }
        // SAFETY: 与上面的 Map 配对。
        unsafe { self.context.Unmap(&staging, 0) };
        Ok(())
    }

    fn staging(&mut self, width: u32, height: u32) -> Result<ID3D11Texture2D, CaptureError> {
        if let Some(staging) = &self.staging
            && staging.width == width
            && staging.height == height
        {
            return Ok(staging.texture.clone());
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0.cast_unsigned(),
            MiscFlags: 0,
        };
        let mut texture = None;
        // SAFETY: 描述结构与输出参数均为局部变量。
        unsafe {
            self.device
                .CreateTexture2D(&raw const desc, None, Some(&raw mut texture))
        }
        .map_err(os("ID3D11Device::CreateTexture2D"))?;
        let texture = texture.ok_or_else(|| missing("ID3D11Device::CreateTexture2D"))?;
        self.staging = Some(Staging {
            texture: texture.clone(),
            width,
            height,
        });
        Ok(texture)
    }

    fn recreate_pool(&mut self, size: SizeInt32) -> Result<(), CaptureError> {
        if size.Width <= 0 || size.Height <= 0 {
            return Ok(());
        }
        self.pool
            .Recreate(&self.winrt_device, PIXEL_FORMAT, POOL_BUFFERS, size)
            .map_err(os("Direct3D11CaptureFramePool::Recreate"))?;
        self.pool_size = size;
        self.stats.pool_recreations += 1;
        Ok(())
    }
}

impl CaptureSource for WgcCapture {
    fn window_identity(&self) -> Option<WindowIdentity> {
        Some(WindowIdentity {
            handle: self.window.hwnd.0 as isize,
            process_id: self.window.process_id,
        })
    }

    fn next_frame(&mut self, timeout: Duration, frame: &mut Frame) -> Result<bool, CaptureError> {
        let deadline = Instant::now().checked_add(timeout);
        loop {
            let seen = self.signal.arrivals();
            if self.signal.is_closed() {
                return Err(CaptureError::WindowClosed);
            }
            check_capturable(self.window.hwnd)?;

            if let Some(wgc_frame) = self.take_latest()? {
                let content = wgc_frame
                    .ContentSize()
                    .map_err(os("Direct3D11CaptureFrame::ContentSize"))?;
                let delivered = self.read_client(&wgc_frame, content, frame);
                let _ = wgc_frame.Close();
                if content != self.pool_size {
                    self.recreate_pool(content)?;
                }
                if delivered? {
                    return Ok(true);
                }
            }

            let now = Instant::now();
            let slice = match deadline {
                Some(deadline) if deadline <= now => return Ok(false),
                Some(deadline) => (deadline - now).min(STATE_POLL_INTERVAL),
                None => STATE_POLL_INTERVAL,
            };
            self.signal.wait(seen, slice);
        }
    }
}

impl Drop for WgcCapture {
    fn drop(&mut self) {
        let _ = self.pool.RemoveFrameArrived(self.frame_arrived_token);
        let _ = self.item.RemoveClosed(self.closed_token);
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// 系统是否支持 WGC。
///
/// # Errors
///
/// 查询失败时返回 [`CaptureError::Os`]。
pub fn is_supported() -> Result<bool, CaptureError> {
    GraphicsCaptureSession::IsSupported().map_err(os("GraphicsCaptureSession::IsSupported"))
}
