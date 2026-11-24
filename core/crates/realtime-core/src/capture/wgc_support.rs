//! WGC 的 D3D11/WinRT 辅助：设备创建、去黄框配置与帧到达同步信号。

use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, GraphicsCaptureAccess, GraphicsCaptureAccessKind,
    GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::core::Interface;

use super::wgc::{BorderRequest, BorderStatus};
use super::{CaptureError, os_error as os};

/// 帧池与采集项的回调到取帧线程的信号。
#[derive(Default)]
pub(super) struct Signal {
    state: Mutex<SignalState>,
    changed: Condvar,
}

#[derive(Default)]
struct SignalState {
    arrivals: u64,
    closed: bool,
}

impl Signal {
    fn lock(&self) -> MutexGuard<'_, SignalState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn frame_arrived(&self) {
        self.lock().arrivals += 1;
        self.changed.notify_all();
    }

    pub(super) fn item_closed(&self) {
        self.lock().closed = true;
        self.changed.notify_all();
    }

    pub(super) fn arrivals(&self) -> u64 {
        self.lock().arrivals
    }

    pub(super) fn is_closed(&self) -> bool {
        self.lock().closed
    }

    pub(super) fn wait(&self, seen: u64, timeout: Duration) {
        let guard = self.lock();
        let _ = self
            .changed
            .wait_timeout_while(guard, timeout, |state| {
                state.arrivals == seen && !state.closed
            })
            .unwrap_or_else(PoisonError::into_inner);
    }
}

pub(super) fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), CaptureError> {
    let mut device = None;
    let mut context = None;
    // SAFETY: 输出参数均为局部变量；硬件设备带 BGRA 支持。
    unsafe {
        D3D11CreateDevice(
            None::<&IDXGIAdapter>,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&raw mut device),
            None,
            Some(&raw mut context),
        )
    }
    .map_err(os("D3D11CreateDevice"))?;
    Ok((
        device.ok_or_else(|| missing("D3D11CreateDevice"))?,
        context.ok_or_else(|| missing("D3D11CreateDevice"))?,
    ))
}

pub(super) fn winrt_device(device: &ID3D11Device) -> Result<IDirect3DDevice, CaptureError> {
    let dxgi: IDXGIDevice = device.cast().map_err(os("ID3D11Device as IDXGIDevice"))?;
    // SAFETY: 有效 DXGI 设备，返回的 WinRT 设备持有其引用。
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .map_err(os("CreateDirect3D11DeviceFromDXGIDevice"))?;
    inspectable.cast().map_err(os(
        "CreateDirect3D11DeviceFromDXGIDevice as IDirect3DDevice",
    ))
}

pub(super) fn frame_texture(
    frame: &Direct3D11CaptureFrame,
) -> Result<ID3D11Texture2D, CaptureError> {
    let surface = frame
        .Surface()
        .map_err(os("Direct3D11CaptureFrame::Surface"))?;
    let access: IDirect3DDxgiInterfaceAccess = surface
        .cast()
        .map_err(os("IDirect3DSurface as IDirect3DDxgiInterfaceAccess"))?;
    // SAFETY: 表面由 WGC 给出，返回其底层 D3D11 纹理的新引用。
    unsafe { access.GetInterface::<ID3D11Texture2D>() }
        .map_err(os("IDirect3DDxgiInterfaceAccess::GetInterface"))
}

/// 请求去掉黄色采集边框：先申请 Borderless 访问再设 `SetIsBorderRequired(false)`。
pub(super) fn configure_border(
    session: &GraphicsCaptureSession,
    request: BorderRequest,
) -> BorderStatus {
    let mut status = BorderStatus {
        request,
        access: None,
        set_error: None,
        border_required: None,
    };
    if request == BorderRequest::Remove {
        let access =
            GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
                .and_then(|operation| operation.join());
        status.access = Some(match access {
            Ok(access) => access_status_name(access).to_owned(),
            Err(error) => describe(&error),
        });
        if let Err(error) = session.SetIsBorderRequired(false) {
            status.set_error = Some(describe(&error));
        }
    }
    status.border_required = session.IsBorderRequired().ok();
    status
}

fn access_status_name(status: AppCapabilityAccessStatus) -> &'static str {
    match status {
        AppCapabilityAccessStatus::DeniedBySystem => "DeniedBySystem",
        AppCapabilityAccessStatus::NotDeclaredByApp => "NotDeclaredByApp",
        AppCapabilityAccessStatus::DeniedByUser => "DeniedByUser",
        AppCapabilityAccessStatus::UserPromptRequired => "UserPromptRequired",
        AppCapabilityAccessStatus::Allowed => "Allowed",
        _ => "Unknown",
    }
}

fn describe(error: &windows::core::Error) -> String {
    format!("0x{:08X}: {}", error.code().0, error.message())
}

pub(super) fn missing(context: &'static str) -> CaptureError {
    CaptureError::Os {
        context,
        code: 0,
        message: "the call succeeded but returned no object".into(),
    }
}
