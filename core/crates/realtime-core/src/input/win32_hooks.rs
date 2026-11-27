//! Windows 低层键鼠钩子（`WH_KEYBOARD_LL` / `WH_MOUSE_LL`）、会话标记与核验/自检工作线程。
//!
//! 钩子回调只做分类与入队后立刻透传 `CallNextHookEx`，绝不阻塞或吞事件；接管、急停与钩子失效
//! 由独立工作线程调用 `Control::local_revoke` 立即释放并撤权。

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::match_same_arms,
    reason = "Win32 钩子消息码与指针宽整数强转是有意的"
)]

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG,
    MSLLHOOKSTRUCT, SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
    WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

use super::backend::{
    SendInputBackend, TargetWindow, VerifyKeys, VerifyRequest, Win32, check_release,
};
use super::hook_logic::{Class, HookState, RawEvent, SelfCheck};
use super::hotkey::Combo;
use super::ledger::InputBackend;
use super::win32_send::RealWin32;
use crate::control::{Control, Notice, Notices};
use crate::protocol::ReleaseReason;

const VERIFY_DELAY: Duration = Duration::from_millis(50);
const SELF_CHECK_INTERVAL: Duration = Duration::from_millis(100);
const HOOK_INSTALL_TIMEOUT: Duration = Duration::from_secs(2);

/// 把通知异步投递到发送队列的回调（钩子线程与核验线程永不阻塞在管道写入上）。
pub(crate) type Post = Arc<dyn Fn(Notices) + Send + Sync>;

pub(crate) struct HookGlobals {
    pub(crate) marker: usize,
    pub(crate) combo: Combo,
    pub(crate) lease_valid: AtomicBool,
    pub(crate) seen: Arc<AtomicU64>,
    pub(crate) last_human_ns: Arc<AtomicU64>,
    pub(crate) state: Mutex<HookState>,
    pub(crate) worker: Sender<Class>,
}

static HOOK: OnceLock<HookGlobals> = OnceLock::new();

fn globals() -> Option<&'static HookGlobals> {
    HOOK.get()
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && let Some(globals) = globals()
    {
        // SAFETY: `HC_ACTION` 时 `lparam` 指向系统传入的 `KBDLLHOOKSTRUCT`。
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let message = wparam.0 as u32;
        let raw = match message {
            WM_KEYDOWN | WM_SYSKEYDOWN => RawEvent::KeyDown {
                vk: info.vkCode as u16,
            },
            WM_KEYUP | WM_SYSKEYUP => RawEvent::KeyUp {
                vk: info.vkCode as u16,
            },
            _ => RawEvent::Other,
        };
        let injected = info.flags.0 & LLKHF_INJECTED.0 != 0;
        classify_and_dispatch(globals, raw, injected, info.dwExtraInfo);
    }
    // SAFETY: 透传给下一个钩子，绝不吞事件。
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && let Some(globals) = globals()
    {
        // SAFETY: `HC_ACTION` 时 `lparam` 指向系统传入的 `MSLLHOOKSTRUCT`。
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let message = wparam.0 as u32;
        let raw = match message {
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN => {
                RawEvent::MouseDown
            }
            WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP => RawEvent::MouseUp,
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => RawEvent::Wheel,
            WM_MOUSEMOVE => mouse_move(info),
            _ => RawEvent::Other,
        };
        let injected = info.flags & LLMHF_INJECTED != 0;
        classify_and_dispatch(globals, raw, injected, info.dwExtraInfo);
    }
    // SAFETY: 透传给下一个钩子。
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn mouse_move(info: &MSLLHOOKSTRUCT) -> RawEvent {
    static LAST: OnceLock<Mutex<Option<POINT>>> = OnceLock::new();
    let last = LAST.get_or_init(|| Mutex::new(None));
    let mut held = last
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (dx, dy) = match *held {
        Some(previous) => (info.pt.x - previous.x, info.pt.y - previous.y),
        None => (0, 0),
    };
    *held = Some(info.pt);
    RawEvent::MouseMove { dx, dy }
}

fn is_human_activity(raw: RawEvent) -> bool {
    match raw {
        RawEvent::MouseMove { dx, dy } => dx.unsigned_abs().saturating_add(dy.unsigned_abs()) >= 2,
        RawEvent::Other => false,
        _ => true,
    }
}

pub(crate) fn classify_and_dispatch(
    globals: &HookGlobals,
    raw: RawEvent,
    injected: bool,
    extra_info: usize,
) {
    let own = injected && extra_info == globals.marker;
    if !own && is_human_activity(raw) {
        globals
            .last_human_ns
            .store(crate::clock::now_ns(), Ordering::Release);
    }
    let lease_valid = globals.lease_valid.load(Ordering::Acquire);
    let class = {
        let mut state = globals
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.classify(raw, injected, own, &globals.combo, lease_valid)
    };
    match class {
        Class::OwnInjection => {
            globals.seen.fetch_add(1, Ordering::Release);
        }
        Class::Takeover | Class::Emergency | Class::HookLost => {
            let _ = globals.worker.send(class);
        }
        Class::Ignore => {}
    }
}

fn run_hook_loop(ready: &Sender<io::Result<()>>) {
    // SAFETY: 回调为本模块 `extern "system"` 函数；低层钩子不需模块句柄。
    let keyboard = match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), None, 0) }
    {
        Ok(handle) => handle,
        Err(error) => {
            let _ = ready.send(Err(io::Error::other(format!(
                "SetWindowsHookExW(WH_KEYBOARD_LL): {error}"
            ))));
            return;
        }
    };
    // SAFETY: 同上。
    let mouse = match unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) } {
        Ok(handle) => handle,
        Err(error) => {
            // SAFETY: 卸载刚安装的键盘钩子。
            let _ = unsafe { UnhookWindowsHookEx(keyboard) };
            let _ = ready.send(Err(io::Error::other(format!(
                "SetWindowsHookExW(WH_MOUSE_LL): {error}"
            ))));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut message = MSG::default();
    // SAFETY: 标准消息循环。
    while unsafe { GetMessageW(&raw mut message, None, 0, 0) }.0 > 0 {}
    if let Some(globals) = HOOK.get() {
        let _ = globals.worker.send(Class::HookLost);
    }
    // SAFETY: 卸载刚安装的钩子。
    unsafe {
        let _ = UnhookWindowsHookEx(keyboard);
        let _ = UnhookWindowsHookEx(mouse);
    }
}

fn spawn_hook_thread() -> io::Result<()> {
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::Builder::new()
        .name("input-hook".into())
        .spawn(move || run_hook_loop(&ready_tx))?;
    match ready_rx.recv_timeout(HOOK_INSTALL_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err(io::Error::other(
            "the low-level hooks were not installed in time",
        )),
    }
}

/// 生成非零 `u32` 会话标记并零扩展至 `usize`（`dwExtraInfo`）。
pub(crate) fn session_marker(
    mut random_word: impl FnMut() -> Result<u32, getrandom::Error>,
) -> usize {
    loop {
        let marker = random_word().expect("系统随机数源不可用");
        if marker != 0 {
            return marker as usize;
        }
    }
}

/// 真实后端启动辅助线程所需的通道与共享句柄。
pub(crate) struct Wiring {
    win32: Arc<dyn Win32>,
    injected: Arc<AtomicU64>,
    seen: Arc<AtomicU64>,
    verify_rx: Receiver<VerifyRequest>,
    verify_keys: Arc<Mutex<VerifyKeys>>,
    worker_rx: Receiver<Class>,
}

/// 构造真实 `SendInput` 后端并安装低层键鼠钩子（装不上即失败，绝不无钩子注入）。
///
/// # Errors
///
/// 无法启动钩子线程或安装钩子失败时返回 IO 错误。
pub(crate) fn build_backend(
    combo: Combo,
    target: Arc<TargetWindow>,
) -> io::Result<(Box<dyn InputBackend>, Wiring)> {
    let marker = session_marker(getrandom::u32);
    let injected = Arc::new(AtomicU64::new(0));
    let seen = Arc::new(AtomicU64::new(0));
    let last_human_ns = Arc::new(AtomicU64::new(crate::clock::now_ns()));
    let verify_keys = Arc::new(Mutex::new(VerifyKeys::default()));
    let win32: Arc<dyn Win32> = Arc::new(RealWin32 {
        marker,
        target,
        injected: Arc::clone(&injected),
    });
    let (verify_tx, verify_rx) = mpsc::channel::<VerifyRequest>();
    let (worker_tx, worker_rx) = mpsc::channel::<Class>();
    HOOK.set(HookGlobals {
        marker,
        combo,
        lease_valid: AtomicBool::new(false),
        seen: Arc::clone(&seen),
        last_human_ns: Arc::clone(&last_human_ns),
        state: Mutex::new(HookState::default()),
        worker: worker_tx,
    })
    .ok();
    spawn_hook_thread().map_err(|error| {
        io::Error::other(format!("failed to install the low-level hooks: {error}"))
    })?;
    let backend = Box::new(SendInputBackend::new(
        Arc::clone(&win32),
        verify_tx,
        Arc::clone(&verify_keys),
        last_human_ns,
    ));
    Ok((
        backend,
        Wiring {
            win32,
            injected,
            seen,
            verify_rx,
            verify_keys,
            worker_rx,
        },
    ))
}

/// 启动物理核验线程、钩子工作线程、许可轮询与自检线程。
///
/// # Errors
///
/// 无法创建工作线程时返回 IO 错误。
pub(crate) fn start(control: &Arc<Control>, post: &Post, wiring: Wiring) -> io::Result<()> {
    spawn_verify(
        control,
        &wiring.win32,
        &wiring.verify_keys,
        post,
        wiring.verify_rx,
    )?;
    spawn_hook_worker(control, post, wiring.worker_rx)?;
    spawn_lease_poller(control)?;
    spawn_self_check(control, post, &wiring.injected, &wiring.seen)?;
    Ok(())
}

fn spawn_verify(
    control: &Arc<Control>,
    win32: &Arc<dyn Win32>,
    verify_keys: &Arc<Mutex<VerifyKeys>>,
    post: &Post,
    requests: Receiver<VerifyRequest>,
) -> io::Result<()> {
    let (control, win32, verify_keys, post) = (
        Arc::clone(control),
        Arc::clone(win32),
        Arc::clone(verify_keys),
        Arc::clone(post),
    );
    thread::Builder::new()
        .name("input-verify".into())
        .spawn(move || {
            while let Ok(request) = requests.recv() {
                if request.reason != ReleaseReason::CoreStart
                    && control
                        .with_verification(request.release_id, || ((), false))
                        .is_some()
                {
                    thread::sleep(VERIFY_DELAY);
                }
                let keys = verify_keys
                    .lock()
                    .map(|keys| keys.clone())
                    .unwrap_or_default();
                let verified = check_release(&control, win32.as_ref(), &keys, request, || {
                    thread::sleep(VERIFY_DELAY);
                });
                let verification = verified.verification;
                let release_id = verified.release_id;
                post(Notices(vec![Notice::Released(verified)]));
                control.verification_posted(release_id, verification);
            }
        })?;
    Ok(())
}

fn spawn_hook_worker(
    control: &Arc<Control>,
    post: &Post,
    classes: Receiver<Class>,
) -> io::Result<()> {
    let (control, post) = (Arc::clone(control), Arc::clone(post));
    thread::Builder::new()
        .name("input-hook-worker".into())
        .spawn(move || {
            while let Ok(class) = classes.recv() {
                let reason = match class {
                    Class::Takeover => ReleaseReason::Takeover,
                    Class::Emergency => ReleaseReason::EmergencyStop,
                    Class::HookLost => ReleaseReason::HookLost,
                    Class::OwnInjection | Class::Ignore => continue,
                };
                post(control.local_revoke(reason));
            }
        })?;
    Ok(())
}

fn spawn_lease_poller(control: &Arc<Control>) -> io::Result<()> {
    let control = Arc::clone(control);
    thread::Builder::new()
        .name("input-lease-poll".into())
        .spawn(move || {
            let mut was_valid = false;
            loop {
                let valid = control.lease_valid();
                if let Some(globals) = globals() {
                    globals.lease_valid.store(valid, Ordering::Release);
                    if valid
                        && !was_valid
                        && let Ok(mut state) = globals.state.lock()
                    {
                        state.lease_became_valid();
                    }
                }
                was_valid = valid;
                thread::sleep(Duration::from_millis(20));
            }
        })?;
    Ok(())
}

fn spawn_self_check(
    control: &Arc<Control>,
    post: &Post,
    injected: &Arc<AtomicU64>,
    seen: &Arc<AtomicU64>,
) -> io::Result<()> {
    let (control, post, injected, seen) = (
        Arc::clone(control),
        Arc::clone(post),
        Arc::clone(injected),
        Arc::clone(seen),
    );
    thread::Builder::new()
        .name("input-self-check".into())
        .spawn(move || {
            let mut check = SelfCheck::default();
            loop {
                thread::sleep(SELF_CHECK_INTERVAL);
                let sent = injected.load(Ordering::Acquire);
                let passed = seen.load(Ordering::Acquire);
                if check.tick(sent, passed) {
                    log!("self-check: own injections did not pass the hook; hooks may be lost");
                    post(control.local_revoke(ReleaseReason::HookLost));
                    break;
                }
            }
        })?;
    Ok(())
}
