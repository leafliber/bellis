//! 顶层窗口枚举、匹配、DWM 几何查询与可采集性检查。

use std::ffi::c_void;

use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
};
use windows::Win32::Graphics::Gdi::{ClientToScreen, MONITOR_DEFAULTTONEAREST, MonitorFromWindow};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Shell::{QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetClientRect, GetForegroundWindow, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
};
use windows::core::{BOOL, PWSTR};

use super::dpi::thread_is_per_monitor_aware_v2;
use super::{
    CaptureError, Rect, WindowGeometry, WindowInfo, WindowSelector, byte_size, os_error as os,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TopLevelWindow {
    pub hwnd: HWND,
    pub process_id: u32,
    pub info: WindowInfo,
}

/// 列出可见、未 cloaked 的顶层窗口（包含最小化窗口以便如实报告最小化）。
///
/// # Errors
///
/// `EnumWindows` 失败时返回 [`CaptureError::Os`]。
pub fn list_windows() -> Result<Vec<TopLevelWindow>, CaptureError> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` 是 `EnumWindows` 同步调用期间有效的 `&mut Vec<HWND>`。
        let handles = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        handles.push(hwnd);
        BOOL::from(true)
    }
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: 回调只追加句柄；`EnumWindows` 同步返回。
    unsafe { EnumWindows(Some(collect), LPARAM(&raw mut handles as isize)) }
        .map_err(os("EnumWindows"))?;
    Ok(handles
        .into_iter()
        .filter(|hwnd| is_candidate(*hwnd))
        .map(describe)
        .collect())
}

/// 按识别条件找唯一窗口；找不到或不唯一均明确报错，不猜测。
///
/// # Errors
///
/// 找不到时返回 [`CaptureError::WindowNotFound`]，多于一个时返回 [`CaptureError::AmbiguousWindow`]。
pub fn find_window(selector: &WindowSelector) -> Result<TopLevelWindow, CaptureError> {
    let mut matches: Vec<TopLevelWindow> = list_windows()?
        .into_iter()
        .filter(|window| selector.matches(&window.info))
        .collect();
    match matches.len() {
        0 => Err(CaptureError::WindowNotFound {
            selector: selector.to_string(),
        }),
        1 => Ok(matches.remove(0)),
        count => Err(CaptureError::AmbiguousWindow {
            selector: selector.to_string(),
            matches: count,
        }),
    }
}

/// 查询窗口物理像素几何：DWM 边界、客户区屏幕范围与显示器有效 DPI。
///
/// # Errors
///
/// 线程非 DPI Aware v2、窗口已关闭或系统调用失败时返回对应错误。
pub fn query_geometry(hwnd: HWND) -> Result<WindowGeometry, CaptureError> {
    if !thread_is_per_monitor_aware_v2() {
        return Err(CaptureError::NotPerMonitorDpiAwareV2);
    }
    let closed_or = |context| {
        move |error| {
            if is_window(hwnd) {
                os(context)(error)
            } else {
                CaptureError::WindowClosed
            }
        }
    };

    let mut bounds = RECT::default();
    // SAFETY: 输出缓冲大小与 RECT 一致。
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut bounds).cast::<c_void>(),
            byte_size::<RECT>(),
        )
    }
    .map_err(closed_or(
        "DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)",
    ))?;

    let mut client = RECT::default();
    // SAFETY: 只写入局部 RECT。
    unsafe { GetClientRect(hwnd, &raw mut client) }.map_err(closed_or("GetClientRect"))?;
    let (width, height) = (client.right - client.left, client.bottom - client.top);
    let mut corners = [
        POINT {
            x: client.left,
            y: client.top,
        },
        POINT {
            x: client.right,
            y: client.bottom,
        },
    ];
    for corner in &mut corners {
        // SAFETY: 只读写局部 POINT。
        if !unsafe { ClientToScreen(hwnd, corner) }.as_bool() {
            return Err(closed_or("ClientToScreen")(
                windows::core::Error::from_thread(),
            ));
        }
    }
    let [a, b] = corners;
    let (left, top) = (a.x.min(b.x), a.y.min(b.y));
    let client = Rect {
        left,
        top,
        right: left + width,
        bottom: top + height,
    };

    // SAFETY: `MONITOR_DEFAULTTONEAREST` 保证返回有效显示器句柄。
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let (mut dpi_x, mut dpi_y) = (0, 0);
    // SAFETY: 只写入两个局部变量。
    unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &raw mut dpi_x, &raw mut dpi_y) }
        .map_err(os("GetDpiForMonitor"))?;

    Ok(WindowGeometry {
        frame_bounds: Rect {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
        },
        client,
        dpi: dpi_x,
    })
}

pub(crate) fn check_capturable(hwnd: HWND) -> Result<(), CaptureError> {
    if !is_window(hwnd) {
        return Err(CaptureError::WindowClosed);
    }
    // SAFETY: 只读窗口状态。
    if unsafe { IsIconic(hwnd) }.as_bool() {
        return Err(CaptureError::WindowMinimized);
    }
    if is_exclusive_fullscreen(hwnd)? {
        return Err(CaptureError::ExclusiveFullscreen);
    }
    Ok(())
}

fn is_exclusive_fullscreen(hwnd: HWND) -> Result<bool, CaptureError> {
    // SAFETY: 只读系统状态。
    let state =
        unsafe { SHQueryUserNotificationState() }.map_err(os("SHQueryUserNotificationState"))?;
    if state != QUNS_RUNNING_D3D_FULL_SCREEN {
        return Ok(false);
    }
    // SAFETY: 只读前台窗口。
    let foreground = unsafe { GetForegroundWindow() };
    Ok(!foreground.is_invalid() && process_id(foreground) == process_id(hwnd))
}

pub(crate) fn is_window(hwnd: HWND) -> bool {
    // SAFETY: 只读窗口状态。
    unsafe { IsWindow(Some(hwnd)) }.as_bool()
}

fn is_candidate(hwnd: HWND) -> bool {
    // SAFETY: 只读窗口状态。
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return false;
    }
    let mut cloaked: u32 = 0;
    // SAFETY: 输出缓冲为 u32。
    let queried = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&raw mut cloaked).cast::<c_void>(),
            byte_size::<u32>(),
        )
    };
    queried.is_err() || cloaked == 0
}

fn describe(hwnd: HWND) -> TopLevelWindow {
    let process_id = process_id(hwnd);
    TopLevelWindow {
        hwnd,
        process_id,
        info: WindowInfo {
            process_image: process_image(process_id),
            class_name: class_name(hwnd),
            title: title(hwnd),
        },
    }
}

fn process_id(hwnd: HWND) -> u32 {
    let mut process_id = 0;
    // SAFETY: 只写入局部变量。
    unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut process_id)) };
    process_id
}

fn title(hwnd: HWND) -> String {
    // SAFETY: 只读窗口文本长度。
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    let mut buffer = vec![0u16; usize::try_from(len).unwrap_or(0) + 1];
    // SAFETY: 缓冲长度由切片给出。
    let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..usize::try_from(copied).unwrap_or(0)])
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 257];
    // SAFETY: 缓冲长度由切片给出。
    let copied = unsafe { GetClassNameW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..usize::try_from(copied).unwrap_or(0)])
}

fn process_image(process_id: u32) -> Option<String> {
    // SAFETY: 仅请求受限查询权限；跨完整性级别也可查到映像路径。
    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let mut buffer = vec![0u16; 32_768];
    let mut len = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
    // SAFETY: `len` 为缓冲容量（UTF-16 单元）。
    let queried = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &raw mut len,
        )
    };
    // SAFETY: 关闭刚打开的进程句柄。
    let _ = unsafe { CloseHandle(process) };
    queried.ok()?;
    Some(String::from_utf16_lossy(
        &buffer[..usize::try_from(len).unwrap_or(0)],
    ))
}

#[cfg(test)]
mod tests {
    use super::{find_window, list_windows};
    use crate::capture::{CaptureError, WindowSelector};

    #[test]
    fn missing_window_is_reported_not_guessed() {
        let selector = WindowSelector {
            process_name: Some("no-such-process-7f3a9c.exe".into()),
            ..WindowSelector::default()
        };
        assert!(matches!(
            find_window(&selector),
            Err(CaptureError::WindowNotFound { .. })
        ));
        list_windows().expect("enumerate windows");
    }
}
