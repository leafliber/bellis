//! 薄 `Win32` trait 接缝、绝对坐标换算、物理残留核验与 `SendInputBackend`。
//!
//! 全部注入构造、前台双重核对、左右键交换、绝对坐标换算与残留补发逻辑均不直接依赖 Win32 FFI，
//! 可经替身 `Win32` 在无桌面单元测试中完整验证。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use crate::capture::{FrameStatus, Geometry, WindowIdentity};
use crate::control::Control;
use crate::input::ledger::{Inject, InputBackend, Momentary};
use crate::protocol::{
    Action, HeldInput, HeldKey, HeldMouseButton, InputPolicy, InputReleasedParams, MouseButton,
    ReleaseReason, ReleaseVerification,
};

/// 真实输入只使用最近写入帧所对应的采集窗口。
pub struct TargetWindow {
    frames: Arc<FrameStatus>,
}

impl TargetWindow {
    #[must_use]
    pub fn new(frames: Arc<FrameStatus>) -> Self {
        Self { frames }
    }

    #[must_use]
    pub fn get(&self) -> Option<(WindowIdentity, Geometry)> {
        self.frames.captured_window()
    }
}

fn is_extended(scan_code: u16) -> bool {
    scan_code >> 8 == 0xE0
}

fn low_scan(scan_code: u16) -> u16 {
    scan_code & 0xFF
}

/// 交给 [`Win32::send`] 的抽象输入事件（均携带本实例非零 `u32` 会话标记）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    KeyDown { scan_code: u16, extended: bool },
    KeyUp { scan_code: u16, extended: bool },
    MouseMoveAbs { x: u16, y: u16 },
    MouseDown { button: PhysicalButton },
    MouseUp { button: PhysicalButton },
    Wheel { notches: i32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhysicalButton {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub window: isize,
    pub client_x: i32,
    pub client_y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Desktop {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyKey {
    Scan(u16),
    Mouse(PhysicalButton),
}

/// 客户区物理像素 `(cx, cy)` 换算为虚拟桌面 0–65535 绝对坐标。
#[must_use]
pub fn absolute(cx: u32, cy: u32, target: Target, desktop: Desktop) -> (u16, u16) {
    let screen_x = i64::from(target.client_x) + i64::from(cx);
    let screen_y = i64::from(target.client_y) + i64::from(cy);
    let norm = |value: i64, origin: i32, span: i32| -> u16 {
        let span = i64::from(span.max(1));
        let numerator = (value - i64::from(origin)) * 65_535 + span / 2;
        let scaled = (numerator / span).clamp(0, 65_535);
        u16::try_from(scaled).unwrap_or(u16::MAX)
    };
    (
        norm(screen_x, desktop.left, desktop.width),
        norm(screen_y, desktop.top, desktop.height),
    )
}

/// 按 `SM_SWAPBUTTON` 将逻辑鼠标键换算为物理鼠标键。
#[must_use]
pub fn physical_button(button: MouseButton, swapped: bool) -> PhysicalButton {
    match (button, swapped) {
        (MouseButton::Left, false) | (MouseButton::Right, true) => PhysicalButton::Left,
        (MouseButton::Right, false) | (MouseButton::Left, true) => PhysicalButton::Right,
        (MouseButton::Middle, _) => PhysicalButton::Middle,
    }
}

fn key_down_event(scan_code: u16) -> Event {
    Event::KeyDown {
        scan_code: low_scan(scan_code),
        extended: is_extended(scan_code),
    }
}

fn key_up_event(scan_code: u16) -> Event {
    Event::KeyUp {
        scan_code: low_scan(scan_code),
        extended: is_extended(scan_code),
    }
}

/// 薄 Win32 接缝：单元测试可用替身完整驱动真实后端逻辑。
pub trait Win32: Send + Sync {
    fn foreground_target(&self) -> Option<Target>;
    fn virtual_desktop(&self) -> Desktop;
    fn buttons_swapped(&self) -> bool;
    fn send(&self, events: &[Event]) -> u32;
    fn can_verify(&self) -> bool;
    fn is_down(&self, key: VerifyKey) -> Option<bool>;
}

fn read_residual(
    win32: &dyn Win32,
    keys: &[u16],
    buttons: &[MouseButton],
) -> Option<Vec<(HeldInput, Event)>> {
    if !win32.can_verify() {
        return None;
    }
    let mut down = Vec::new();
    for &scan_code in keys {
        if win32.is_down(VerifyKey::Scan(scan_code))? {
            down.push((
                HeldInput::Key(HeldKey { scan_code }),
                key_up_event(scan_code),
            ));
        }
    }
    let swapped = win32.buttons_swapped();
    for &button in buttons {
        let physical = physical_button(button, swapped);
        if win32.is_down(VerifyKey::Mouse(physical))? {
            down.push((
                HeldInput::MouseButton(HeldMouseButton { button }),
                Event::MouseUp { button: physical },
            ));
        }
    }
    (win32.can_verify() && swapped == win32.buttons_swapped()).then_some(down)
}

/// 读白名单内按住的项并补发抬起，返回 `(残留项, 系统是否接受全部补发)`。
#[must_use]
pub fn verify_residual(
    win32: &dyn Win32,
    keys: &[u16],
    buttons: &[MouseButton],
) -> Option<(Vec<HeldInput>, bool)> {
    let (items, ups): (Vec<_>, Vec<_>) = read_residual(win32, keys, buttons)?.into_iter().unzip();
    let repair_accepted = ups.is_empty() || win32.send(&ups) as usize == ups.len();
    Some((items, repair_accepted))
}

fn no_residual(win32: &dyn Win32, keys: &[u16], buttons: &[MouseButton]) -> Option<bool> {
    Some(read_residual(win32, keys, buttons)?.is_empty())
}

/// 请求一次物理残留核验。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifyRequest {
    pub release_id: u64,
    pub reason: ReleaseReason,
}

/// 核验线程读取的白名单键与鼠标键。
#[derive(Clone, Debug, Default)]
pub struct VerifyKeys {
    pub configured: bool,
    pub swapped: bool,
    pub keys: Vec<u16>,
    pub buttons: Vec<MouseButton>,
}

impl VerifyKeys {
    fn can_check(&self, win32: &dyn Win32) -> bool {
        self.configured && (self.buttons.is_empty() || win32.buttons_swapped() == self.swapped)
    }
}

/// 执行一次物理残留核验（含补发抬起与复查），返回最终要发出的 `InputReleasedParams`。
pub fn check_release(
    control: &Control,
    win32: &dyn Win32,
    keys: &VerifyKeys,
    request: VerifyRequest,
    wait_for_repair: impl FnOnce(),
) -> InputReleasedParams {
    let id = request.release_id;
    let mut residual_items = Vec::new();
    let read = control
        .with_verification(id, || {
            let observed = keys
                .can_check(win32)
                .then(|| verify_residual(win32, &keys.keys, &keys.buttons))
                .flatten();
            let repair_rejected = observed.as_ref().is_some_and(|(_, accepted)| !accepted);
            (observed, repair_rejected)
        })
        .flatten();
    let verification = match read {
        None => ReleaseVerification::Unavailable,
        Some((items, _)) if items.is_empty() => ReleaseVerification::Verified,
        Some((items, repair_accepted)) => {
            residual_items = items;
            if repair_accepted {
                wait_for_repair();
                match control
                    .with_verification(id, || {
                        let clear = keys
                            .can_check(win32)
                            .then(|| no_residual(win32, &keys.keys, &keys.buttons))
                            .flatten();
                        (clear, false)
                    })
                    .flatten()
                {
                    Some(true) => ReleaseVerification::Verified,
                    Some(false) => ReleaseVerification::Residual,
                    None => ReleaseVerification::Unavailable,
                }
            } else {
                ReleaseVerification::Residual
            }
        }
    };
    control.finish_verification(id, request.reason, verification, residual_items)
}

/// 真实 `SendInput` 后端（泛型于 [`Win32`] 接缝）。
pub struct SendInputBackend {
    win32: Arc<dyn Win32>,
    verify: Sender<VerifyRequest>,
    verify_keys: Arc<Mutex<VerifyKeys>>,
    last_human_ns: Arc<AtomicU64>,
    startup: Option<VerifyRequest>,
    configured_swap: Option<bool>,
}

impl SendInputBackend {
    #[must_use]
    pub fn new(
        win32: Arc<dyn Win32>,
        verify: Sender<VerifyRequest>,
        verify_keys: Arc<Mutex<VerifyKeys>>,
        last_human_ns: Arc<AtomicU64>,
    ) -> Self {
        Self {
            win32,
            verify,
            verify_keys,
            last_human_ns,
            startup: None,
            configured_swap: None,
        }
    }

    fn inject_down(&self, build: impl Fn(Target, Desktop) -> Vec<Event>) -> Inject {
        let Some(before) = self.win32.foreground_target() else {
            return Inject::FocusLost;
        };
        let events = build(before, self.win32.virtual_desktop());
        let sent = self.win32.send(&events);
        if (sent as usize) < events.len() {
            return Inject::Blocked;
        }
        match self.win32.foreground_target() {
            Some(after) if after.window == before.window => Inject::Done,
            _ => Inject::FocusChanged,
        }
    }

    fn inject_up(&self, events: &[Event]) -> bool {
        self.win32.send(events) as usize == events.len()
    }

    fn mouse_button(&self, button: MouseButton) -> PhysicalButton {
        physical_button(
            button,
            self.configured_swap
                .unwrap_or_else(|| self.win32.buttons_swapped()),
        )
    }

    fn mouse_mapping_matches(&self) -> bool {
        self.configured_swap
            .is_none_or(|swapped| self.win32.buttons_swapped() == swapped)
    }
}

impl InputBackend for SendInputBackend {
    fn press(&mut self, input: &HeldInput) -> Inject {
        match input {
            HeldInput::Key(key) => {
                let scan = key.scan_code;
                self.inject_down(move |_, _| vec![key_down_event(scan)])
            }
            HeldInput::MouseButton(button) => {
                if !self.mouse_mapping_matches() {
                    return Inject::Blocked;
                }
                let physical = self.mouse_button(button.button);
                self.inject_down(move |_, _| vec![Event::MouseDown { button: physical }])
            }
            HeldInput::Axis(_) => Inject::Done,
        }
    }

    fn release(&mut self, input: &HeldInput) -> bool {
        match input {
            HeldInput::Key(key) => self.inject_up(&[key_up_event(key.scan_code)]),
            HeldInput::MouseButton(button) => self.inject_up(&[Event::MouseUp {
                button: self.mouse_button(button.button),
            }]),
            HeldInput::Axis(_) => true,
        }
    }

    fn act(&mut self, action: &Action) -> Inject {
        match action {
            Action::Scroll(scroll) => {
                let (cx, cy, notches) = (scroll.x, scroll.y, scroll.notches);
                self.inject_down(move |target, desktop| {
                    let (x, y) = absolute(cx, cy, target, desktop);
                    vec![Event::MouseMoveAbs { x, y }, Event::Wheel { notches }]
                })
            }
            Action::Click(_) | Action::KeyPress(_) | Action::MouseMove(_) => Inject::Done,
        }
    }

    fn begin_momentary(&mut self, momentary: &Momentary) -> Inject {
        match *momentary {
            Momentary::Click { x, y, button } => {
                if !self.mouse_mapping_matches() {
                    return Inject::Blocked;
                }
                let physical = self.mouse_button(button);
                self.inject_down(move |target, desktop| {
                    let (ax, ay) = absolute(x, y, target, desktop);
                    vec![
                        Event::MouseMoveAbs { x: ax, y: ay },
                        Event::MouseDown { button: physical },
                    ]
                })
            }
            Momentary::Key { scan_code } => {
                self.inject_down(move |_, _| vec![key_down_event(scan_code)])
            }
        }
    }

    fn end_momentary(&mut self, momentary: &Momentary) -> bool {
        match *momentary {
            Momentary::Click { button, .. } => self.inject_up(&[Event::MouseUp {
                button: self.mouse_button(button),
            }]),
            Momentary::Key { scan_code } => self.inject_up(&[key_up_event(scan_code)]),
        }
    }

    fn verifies_release(&self) -> bool {
        true
    }

    fn target_focused(&self) -> bool {
        self.win32.foreground_target().is_some()
    }

    fn human_idle_ms(&self, now_ns: u64) -> Option<u64> {
        let last = self.last_human_ns.load(Ordering::Acquire);
        Some(now_ns.saturating_sub(last) / 1_000_000)
    }

    fn released_all(&mut self, reason: ReleaseReason, release_id: u64) {
        let request = VerifyRequest { release_id, reason };
        if reason == ReleaseReason::CoreStart {
            self.startup = Some(request);
        } else {
            let _ = self.verify.send(request);
        }
    }

    fn configured(&mut self, policy: &InputPolicy) {
        let swapped = self.win32.buttons_swapped();
        self.configured_swap = Some(swapped);
        if let Ok(mut keys) = self.verify_keys.lock() {
            keys.keys = policy
                .press_keys
                .iter()
                .chain(&policy.hold_keys)
                .copied()
                .collect();
            keys.buttons = policy
                .click_buttons
                .iter()
                .chain(&policy.hold_buttons)
                .copied()
                .collect();
            keys.configured = true;
            keys.swapped = swapped;
        }
        if let Some(request) = self.startup.take() {
            let _ = self.verify.send(request);
        }
    }
}
