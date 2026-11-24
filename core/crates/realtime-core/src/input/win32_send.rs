//! Windows 真实 `Win32` 实现：`SendInput`（扫描码 + 绝对坐标 + 非零 u32 会话标记）、
//! 前台与活动输入桌面核对、`GetAsyncKeyState` 物理残留检查。

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    reason = "Win32 FFI 的键码、坐标与结构大小强转是有意的"
)]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_HOOKCONTROL, OpenInputDesktop,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VSC_TO_VK_EX,
    MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MapVirtualKeyW,
    SendInput, VIRTUAL_KEY, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_SWAPBUTTON,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SYSTEM_METRICS_INDEX,
};

use super::backend::{Desktop, Event, PhysicalButton, Target, TargetWindow, VerifyKey, Win32};
use super::hook_logic::self_check_count;
use crate::capture::query_geometry;

/// 真实的 Win32 注入与状态查询实现。
pub(crate) struct RealWin32 {
    pub(crate) marker: usize,
    pub(crate) target: Arc<TargetWindow>,
    pub(crate) injected: Arc<AtomicU64>,
}

pub(crate) fn to_input(event: Event, marker: usize) -> INPUT {
    match event {
        Event::KeyDown {
            scan_code,
            extended,
        } => keyboard(scan_code, extended, false, marker),
        Event::KeyUp {
            scan_code,
            extended,
        } => keyboard(scan_code, extended, true, marker),
        Event::MouseMoveAbs { x, y } => mouse(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            i32::from(x),
            i32::from(y),
            0,
            marker,
        ),
        Event::MouseDown { button } => mouse(down_flag(button), 0, 0, 0, marker),
        Event::MouseUp { button } => mouse(up_flag(button), 0, 0, 0, marker),
        Event::Wheel { notches } => mouse(MOUSEEVENTF_WHEEL, 0, 0, notches * 120, marker),
    }
}

fn send_events(events: &[Event], marker: usize) -> u32 {
    let inputs: Vec<INPUT> = events.iter().map(|e| to_input(*e, marker)).collect();
    // SAFETY: `inputs` 为有效本地数组，大小参数与元素类型匹配。
    unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) }
}

fn keyboard(scan_code: u16, extended: bool, up: bool, marker: usize) -> INPUT {
    let mut flags = KEYEVENTF_SCANCODE;
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan_code,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: marker,
            },
        },
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32, marker: usize) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: marker,
            },
        },
    }
}

fn down_flag(button: PhysicalButton) -> MOUSE_EVENT_FLAGS {
    match button {
        PhysicalButton::Left => MOUSEEVENTF_LEFTDOWN,
        PhysicalButton::Right => MOUSEEVENTF_RIGHTDOWN,
        PhysicalButton::Middle => MOUSEEVENTF_MIDDLEDOWN,
    }
}

fn up_flag(button: PhysicalButton) -> MOUSE_EVENT_FLAGS {
    match button {
        PhysicalButton::Left => MOUSEEVENTF_LEFTUP,
        PhysicalButton::Right => MOUSEEVENTF_RIGHTUP,
        PhysicalButton::Middle => MOUSEEVENTF_MIDDLEUP,
    }
}

fn metric(index: SYSTEM_METRICS_INDEX) -> i32 {
    // SAFETY: 只读系统度量。
    unsafe { GetSystemMetrics(index) }
}

fn on_input_desktop() -> bool {
    // SAFETY: 只读当前前台窗口句柄。
    !unsafe { GetForegroundWindow() }.is_invalid()
}

fn scan_to_vk(scan_code: u16) -> Option<u16> {
    let sc = if scan_code >> 8 == 0xE0 {
        0xE000 | (scan_code & 0xFF)
    } else {
        scan_code & 0xFF
    };
    // SAFETY: `MapVirtualKeyW` 只做扫描码映射。
    let vk = unsafe { MapVirtualKeyW(u32::from(sc), MAPVK_VSC_TO_VK_EX) };
    (vk != 0).then_some(vk as u16)
}

impl Win32 for RealWin32 {
    fn foreground_target(&self) -> Option<Target> {
        let (window, captured) = self.target.get()?;
        let hwnd = HWND(window.handle as *mut std::ffi::c_void);
        let mut process_id = 0;
        // SAFETY: 只读窗口可见/最小化状态与所属 PID。
        let ok = unsafe {
            IsWindow(Some(hwnd)).as_bool()
                && IsWindowVisible(hwnd).as_bool()
                && !IsIconic(hwnd).as_bool()
                && GetWindowThreadProcessId(hwnd, Some(&raw mut process_id)) != 0
        };
        if !ok || process_id != window.process_id {
            return None;
        }
        // SAFETY: 只读前台窗口。
        if unsafe { GetForegroundWindow() } != hwnd {
            return None;
        }
        if !on_input_desktop() {
            return None;
        }
        let geometry = query_geometry(hwnd).ok()?;
        let size = geometry.client.size();
        if (size.width, size.height, geometry.dpi)
            != (captured.width, captured.height, captured.dpi)
        {
            return None;
        }
        Some(Target {
            window: window.handle,
            client_x: geometry.client.left,
            client_y: geometry.client.top,
        })
    }

    fn virtual_desktop(&self) -> Desktop {
        Desktop {
            left: metric(SM_XVIRTUALSCREEN),
            top: metric(SM_YVIRTUALSCREEN),
            width: metric(SM_CXVIRTUALSCREEN),
            height: metric(SM_CYVIRTUALSCREEN),
        }
    }

    fn buttons_swapped(&self) -> bool {
        metric(SM_SWAPBUTTON) != 0
    }

    fn send(&self, events: &[Event]) -> u32 {
        let sent = send_events(events, self.marker);
        self.injected
            .fetch_add(self_check_count(events, sent), Ordering::Release);
        sent
    }

    fn can_verify(&self) -> bool {
        // SAFETY: 只申请活动桌面的钩子访问权，不切换桌面、不继承句柄。
        let Ok(desktop) =
            (unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_HOOKCONTROL) })
        else {
            return false;
        };
        let mut point = POINT::default();
        // SAFETY: 只写本地 POINT，在非活动桌面会失败。
        let active = unsafe { GetCursorPos(&raw mut point) }.is_ok();
        // SAFETY: 关闭刚打开的桌面句柄。
        let _ = unsafe { CloseDesktop(desktop) };
        active
    }

    fn is_down(&self, key: VerifyKey) -> Option<bool> {
        let vk = match key {
            VerifyKey::Scan(scan) => scan_to_vk(scan)?,
            VerifyKey::Mouse(PhysicalButton::Left) => VK_LBUTTON.0,
            VerifyKey::Mouse(PhysicalButton::Right) => VK_RBUTTON.0,
            VerifyKey::Mouse(PhysicalButton::Middle) => VK_MBUTTON.0,
        };
        // SAFETY: 只读异步物理按键状态。
        let state = unsafe { GetAsyncKeyState(i32::from(vk)) };
        Some((state as u16 & 0x8000) != 0)
    }
}
