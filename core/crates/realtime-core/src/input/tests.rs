//! 输入模块单元测试：替身 `Win32` 覆盖注入构造、前台双重核对、绝对坐标、`SM_SWAPBUTTON`、
//! 急停组合键、钩子分类、钩子自检、会话标记与 `GetAsyncKeyState` 物理残留核验。

#![allow(clippy::cast_possible_truncation, clippy::assert_is_empty)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT_KEYBOARD, INPUT_MOUSE};

use crate::capture::FrameStatus;
use crate::control::{Control, Limits};
use crate::input::win32_hooks::{HookGlobals, classify_and_dispatch, session_marker};
use crate::input::win32_send::to_input;
use crate::input::{
    Class, Combo, Desktop, Event, HookState, Inject, InputBackend, MOVE_THRESHOLD_PX, Momentary,
    PhysicalButton, RawEvent, SelfCheck, SendInputBackend, Target, VerifyKey, VerifyKeys,
    VerifyRequest, Win32, absolute, check_release, normalize_vk, physical_button, self_check_count,
    verify_residual,
};
use crate::protocol::{
    Action, HeldInput, HeldKey, InputPolicy, MouseButton, NormRect, ReleaseReason,
    ReleaseVerification, Scroll,
};

#[derive(Default)]
struct MockWin32 {
    inner: Mutex<MockInner>,
}

#[derive(Default)]
struct MockInner {
    targets: Vec<Option<Target>>,
    cursor: usize,
    swapped: bool,
    accept: Option<usize>,
    down_scans: Vec<u16>,
    down_buttons: Vec<PhysicalButton>,
    desktop_unavailable: bool,
    sent: Vec<Vec<Event>>,
}

impl MockWin32 {
    fn with_targets(targets: Vec<Option<Target>>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(MockInner {
                targets,
                ..MockInner::default()
            }),
        })
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, MockInner> {
        self.inner.lock().unwrap()
    }
}

impl Win32 for MockWin32 {
    fn foreground_target(&self) -> Option<Target> {
        let mut inner = self.inner();
        let idx = inner.cursor.min(inner.targets.len().saturating_sub(1));
        inner.cursor += 1;
        inner.targets.get(idx).copied().flatten()
    }

    fn virtual_desktop(&self) -> Desktop {
        Desktop {
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
        }
    }

    fn buttons_swapped(&self) -> bool {
        self.inner().swapped
    }

    fn send(&self, events: &[Event]) -> u32 {
        let mut inner = self.inner();
        inner.sent.push(events.to_vec());
        inner
            .accept
            .map_or(events.len(), |cap| cap.min(events.len())) as u32
    }

    fn can_verify(&self) -> bool {
        !self.inner().desktop_unavailable
    }

    fn is_down(&self, key: VerifyKey) -> Option<bool> {
        let inner = self.inner();
        Some(match key {
            VerifyKey::Scan(sc) => inner.down_scans.contains(&sc),
            VerifyKey::Mouse(btn) => inner.down_buttons.contains(&btn),
        })
    }
}

fn target(window: isize) -> Target {
    Target {
        window,
        client_x: 100,
        client_y: 200,
    }
}

#[test]
fn absolute_coordinates_and_swapped_mouse_buttons() {
    let desktop = Desktop {
        left: -1920,
        top: 0,
        width: 3840,
        height: 1080,
    };
    let (x, y) = absolute(
        0,
        0,
        Target {
            window: 1,
            client_x: -1920,
            client_y: 0,
        },
        desktop,
    );
    assert!(x < 20 && y < 40);
    assert_eq!(
        physical_button(MouseButton::Left, false),
        PhysicalButton::Left
    );
    assert_eq!(
        physical_button(MouseButton::Left, true),
        PhysicalButton::Right
    );
    assert_eq!(
        physical_button(MouseButton::Right, true),
        PhysicalButton::Left
    );
}

#[test]
fn sendinput_backend_checks_foreground_before_and_after_and_detects_blocking() {
    let win32 = MockWin32::with_targets(vec![
        None,
        Some(target(1)),
        Some(target(2)),
        Some(target(1)),
        Some(target(1)),
    ]);
    let (tx, _rx) = mpsc::channel();
    let keys = Arc::new(Mutex::new(VerifyKeys::default()));
    let last_human = Arc::new(AtomicU64::new(1_000_000_000));
    let mut backend = SendInputBackend::new(win32.clone(), tx, keys, Arc::clone(&last_human));
    assert_eq!(backend.human_idle_ms(6_500_000_000), Some(5_500));

    // 注入前失焦：零注入。
    assert_eq!(
        backend.begin_momentary(&Momentary::Key { scan_code: 0x11 }),
        Inject::FocusLost
    );
    assert!(win32.inner().sent.is_empty());

    // 注入过程中前台切换：返回 FocusChanged。
    assert_eq!(
        backend.begin_momentary(&Momentary::Click {
            x: 10,
            y: 20,
            button: MouseButton::Left,
        }),
        Inject::FocusChanged
    );
    assert_eq!(win32.inner().sent.len(), 1);

    // SendInput 返回计数不足：返回 Blocked。
    win32.inner().accept = Some(1);
    assert_eq!(
        backend.act(&Action::Scroll(Scroll {
            id: 1,
            x: 10,
            y: 20,
            notches: 1,
        })),
        Inject::Blocked
    );
}

#[test]
fn hook_classification_emergency_hotkey_and_self_check() {
    let combo = Combo::parse("ctrl+shift+f12").unwrap();
    assert_eq!(combo, Combo::default_hotkey());
    assert_eq!(normalize_vk(0xA2), 0x11);
    let mut state = HookState::default();

    // 急停组合键无论许可是否有效都触发。
    assert_eq!(
        state.classify(RawEvent::KeyDown { vk: 0xA2 }, false, false, &combo, false),
        Class::Ignore
    );
    assert_eq!(
        state.classify(RawEvent::KeyDown { vk: 0xA0 }, false, false, &combo, false),
        Class::Ignore
    );
    assert_eq!(
        state.classify(RawEvent::KeyDown { vk: 0x7B }, false, false, &combo, false),
        Class::Emergency
    );

    // 许可有效时真人微小移动不触发，超过阈值触发接管；本实例注入忽略并计入自检。
    state.lease_became_valid();
    assert_eq!(
        state.classify(
            RawEvent::MouseMove { dx: 2, dy: 2 },
            false,
            false,
            &combo,
            true
        ),
        Class::Ignore
    );
    assert_eq!(
        state.classify(
            RawEvent::MouseMove {
                dx: MOVE_THRESHOLD_PX as i32,
                dy: 0,
            },
            false,
            false,
            &combo,
            true
        ),
        Class::Takeover
    );
    assert_eq!(
        state.classify(RawEvent::MouseDown, true, true, &combo, true),
        Class::OwnInjection
    );
    // 第三方注入无本实例标记 -> 判接管。
    assert_eq!(
        state.classify(RawEvent::MouseDown, true, false, &combo, true),
        Class::Takeover
    );

    let mut check = SelfCheck::default();
    assert!(!check.tick(3, 3));
    assert!(!check.tick(5, 3));
    assert!(check.tick(5, 3), "上一轮的 2 个事件未经过钩子");
    assert!(!check.tick(5, 3), "同一批只报一次");
}

#[test]
fn session_marker_roundtrips_through_win32_inputs_and_hook_dispatch() {
    let mut words = [0, 0, 0x8000_0001].into_iter();
    let marker = session_marker(|| Ok(words.next().expect("non-zero")));
    assert_eq!(marker, 0x8000_0001);

    let (worker, classes) = mpsc::channel();
    let last_human_ns = Arc::new(AtomicU64::new(42));
    let globals = HookGlobals {
        marker,
        combo: Combo::default_hotkey(),
        lease_valid: AtomicBool::new(true),
        seen: Arc::new(AtomicU64::new(0)),
        last_human_ns: Arc::clone(&last_human_ns),
        state: Mutex::new(HookState::default()),
        worker,
    };
    let events = [
        Event::MouseMoveAbs { x: 1, y: 2 },
        Event::MouseDown {
            button: PhysicalButton::Left,
        },
        Event::KeyDown {
            scan_code: 0x11,
            extended: false,
        },
    ];
    let raws = [
        RawEvent::MouseMove { dx: 50, dy: 50 },
        RawEvent::MouseDown,
        RawEvent::KeyDown { vk: 0x57 },
    ];
    for (event, raw) in events.into_iter().zip(raws) {
        let input = to_input(event, marker);
        let extra = if input.r#type == INPUT_MOUSE {
            // SAFETY: 鼠标事件写入 `mi`。
            unsafe { input.Anonymous.mi.dwExtraInfo }
        } else {
            assert_eq!(input.r#type, INPUT_KEYBOARD);
            // SAFETY: 键盘事件写入 `ki`。
            unsafe { input.Anonymous.ki.dwExtraInfo }
        };
        classify_and_dispatch(&globals, raw, true, (extra as u32) as usize);
    }
    assert_eq!(globals.seen.load(Ordering::Acquire), 2);
    assert_eq!(last_human_ns.load(Ordering::Acquire), 42);
    classify_and_dispatch(&globals, RawEvent::MouseMove { dx: 1, dy: 0 }, false, 0);
    assert_eq!(last_human_ns.load(Ordering::Acquire), 42);
    classify_and_dispatch(&globals, RawEvent::KeyDown { vk: 0x57 }, false, 0);
    assert!(last_human_ns.load(Ordering::Acquire) > 42);
    assert_eq!(self_check_count(&events, 3), 2);
    assert_eq!(classes.try_recv(), Ok(Class::Takeover));
}

#[test]
fn residual_verification_repairs_stuck_keys_and_rechecks() {
    let win32 = MockWin32::with_targets(vec![Some(target(1))]);
    win32.inner().down_scans = vec![0x11];
    let (tx, _rx) = mpsc::channel();
    let verify_keys = Arc::new(Mutex::new(VerifyKeys::default()));
    let backend = Box::new(SendInputBackend::new(
        win32.clone(),
        tx,
        Arc::clone(&verify_keys),
        Arc::new(AtomicU64::new(0)),
    ));
    let control = Control::new(
        Limits {
            heartbeat_timeout: Duration::from_millis(500),
            max_frame_age: Duration::from_millis(500),
        },
        Arc::new(FrameStatus::default()),
        Some(backend),
        true,
    );
    let startup = control.release_on_start();
    let policy = InputPolicy {
        click_buttons: vec![MouseButton::Left],
        press_keys: vec![0x11],
        scroll: false,
        click_regions: vec![NormRect {
            left: 0.0,
            top: 0.0,
            right: 1.0,
            bottom: 1.0,
        }],
        forbidden_zones: vec![],
        press_duration_ms: 40,
        max_rate: 5.0,
        hold_keys: vec![],
        hold_buttons: vec![],
        max_hold_ms: None,
    };
    control.configure(&policy).unwrap();

    // 首次检查看到 0x11 按住 -> 补发抬起 -> wait_for_repair 清空 -> 复查通过！
    let keys = verify_keys.lock().unwrap().clone();
    let result = check_release(
        &control,
        win32.as_ref(),
        &keys,
        VerifyRequest {
            release_id: startup.release_id,
            reason: ReleaseReason::CoreStart,
        },
        || {
            win32.inner().down_scans.clear();
        },
    );
    assert_eq!(result.release_id, startup.release_id);
    assert_eq!(result.verification, ReleaseVerification::Verified);
    assert_eq!(
        result.residual_items,
        vec![HeldInput::Key(HeldKey { scan_code: 0x11 })]
    );
    // verify_residual 在干净状态下返回空。
    assert_eq!(
        verify_residual(win32.as_ref(), &[0x11], &[MouseButton::Left]),
        Some((vec![], true))
    );
}
