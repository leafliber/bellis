//! 输入后端接口、持键账目与 Fail-Closed 全量释放。

use crate::protocol::{Action, HeldInput, InputPolicy, MouseButton, ReleaseReason};

/// 一次按下类注入的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Inject {
    Done,
    FocusLost,
    FocusChanged,
    Blocked,
}

impl Inject {
    /// 是否有事件已发出（决定是否记入持键账目以便释放）。
    #[must_use]
    pub fn injected(self) -> bool {
        !matches!(self, Self::FocusLost)
    }
}

/// 点击或短按作为瞬时按住注入时的描述。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Momentary {
    Click { x: u32, y: u32, button: MouseButton },
    Key { scan_code: u16 },
}

/// 输入后端：所有方法在控制锁内调用，须快速返回、不得阻塞等待网络 IO。
pub trait InputBackend: Send {
    fn press(&mut self, input: &HeldInput) -> Inject;
    fn release(&mut self, input: &HeldInput) -> bool;
    fn act(&mut self, action: &Action) -> Inject;
    fn begin_momentary(&mut self, momentary: &Momentary) -> Inject;
    fn end_momentary(&mut self, momentary: &Momentary) -> bool;
    fn released_all(&mut self, reason: ReleaseReason, release_id: u64);

    fn verifies_release(&self) -> bool {
        false
    }

    fn target_focused(&self) -> bool {
        false
    }

    fn human_idle_ms(&self, _now_ns: u64) -> Option<u64> {
        None
    }

    fn configured(&mut self, policy: &InputPolicy) {
        let _ = policy;
    }
}

/// 持续状态一项的身份：键按扫描码、鼠标键按键、轴按轴名。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum HeldId {
    Key(u16),
    MouseButton(MouseButton),
    Axis(String),
}

impl HeldId {
    #[must_use]
    pub fn of(input: &HeldInput) -> Self {
        match input {
            HeldInput::Key(key) => Self::Key(key.scan_code),
            HeldInput::MouseButton(button) => Self::MouseButton(button.button),
            HeldInput::Axis(axis) => Self::Axis(axis.axis.clone()),
        }
    }
}

struct Held {
    input: HeldInput,
    pressed_ns: u64,
}

struct Transient {
    momentary: Momentary,
    lift_ns: u64,
}

/// 本实例按下且尚未抬起的输入账目（持续状态 + 瞬时按住）。
pub struct InputLedger {
    backend: Option<Box<dyn InputBackend>>,
    held: Vec<Held>,
    transients: Vec<Transient>,
}

impl InputLedger {
    #[must_use]
    pub fn new(backend: Option<Box<dyn InputBackend>>) -> Self {
        Self {
            backend,
            held: Vec::new(),
            transients: Vec::new(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.held.is_empty() && self.transients.is_empty()
    }

    #[must_use]
    pub fn holds(&self, input: &HeldInput) -> bool {
        self.held.iter().any(|held| held.input == *input)
    }

    #[must_use]
    pub fn has_transient(&self) -> bool {
        !self.transients.is_empty()
    }

    #[must_use]
    pub fn target_focused(&self) -> bool {
        self.backend
            .as_ref()
            .is_some_and(|backend| backend.target_focused())
    }

    #[must_use]
    pub fn human_idle_ms(&self, now_ns: u64) -> Option<u64> {
        self.backend
            .as_ref()
            .and_then(|backend| backend.human_idle_ms(now_ns))
    }

    /// 抬起身份不在 `keep` 中的每一项持续状态。
    pub fn release_missing(&mut self, keep: &[HeldInput]) -> bool {
        let keep: Vec<HeldId> = keep.iter().map(HeldId::of).collect();
        let backend = &mut self.backend;
        let mut accepted = true;
        self.held.retain(|held| {
            if keep.contains(&HeldId::of(&held.input)) {
                return true;
            }
            let released = backend.as_mut().is_none_or(|b| b.release(&held.input));
            accepted &= released;
            !released
        });
        accepted
    }

    /// 按下一项持续状态，或更新同名轴取值。
    pub fn press(&mut self, input: HeldInput, now: u64) -> Inject {
        let result = self
            .backend
            .as_mut()
            .map_or(Inject::Done, |backend| backend.press(&input));
        if result.injected() {
            let id = HeldId::of(&input);
            match self
                .held
                .iter_mut()
                .find(|held| HeldId::of(&held.input) == id)
            {
                Some(held) => held.input = input,
                None => self.held.push(Held {
                    input,
                    pressed_ns: now,
                }),
            }
        }
        result
    }

    pub fn configured(&mut self, policy: &InputPolicy) {
        if let Some(backend) = self.backend.as_mut() {
            backend.configured(policy);
        }
    }

    pub fn act(&mut self, action: &Action) -> Inject {
        self.backend
            .as_mut()
            .map_or(Inject::Done, |backend| backend.act(action))
    }

    pub fn begin_momentary(&mut self, momentary: Momentary, lift_ns: u64) -> Inject {
        let result = self
            .backend
            .as_mut()
            .map_or(Inject::Done, |backend| backend.begin_momentary(&momentary));
        if result.injected() {
            self.transients.push(Transient { momentary, lift_ns });
        }
        result
    }

    /// 抬起到 `now` 为止到期的瞬时按住。
    pub fn lift_due(&mut self, now: u64) -> bool {
        let backend = &mut self.backend;
        let mut accepted = true;
        self.transients.retain(|transient| {
            if now < transient.lift_ns {
                return true;
            }
            let released = backend
                .as_mut()
                .is_none_or(|b| b.end_momentary(&transient.momentary));
            accepted &= released;
            !released
        });
        accepted
    }

    #[must_use]
    pub fn next_lift(&self) -> Option<u64> {
        self.transients.iter().map(|t| t.lift_ns).min()
    }

    #[must_use]
    pub fn earliest_held_ns(&self) -> Option<u64> {
        self.held.iter().map(|held| held.pressed_ns).min()
    }

    /// 先逆序抬起全部瞬时按住，再逆序抬起全部持续状态并清空账目。
    pub fn release_all(&mut self, reason: ReleaseReason, release_id: u64) -> bool {
        let mut accepted = true;
        if let Some(backend) = self.backend.as_mut() {
            for transient in self.transients.iter().rev() {
                accepted &= backend.end_momentary(&transient.momentary);
            }
            for held in self.held.iter().rev() {
                accepted &= backend.release(&held.input);
            }
            backend.released_all(reason, release_id);
        }
        self.transients.clear();
        self.held.clear();
        accepted
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::{Inject, InputBackend, InputLedger, Momentary};
    use crate::protocol::{
        Action, HeldAxis, HeldInput, HeldKey, HeldMouseButton, MouseButton, ReleaseReason,
    };
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    pub(crate) struct Recorder(pub(crate) Arc<Mutex<Vec<String>>>);

    impl Recorder {
        pub(crate) fn take(&self) -> Vec<String> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }

        #[allow(clippy::unnecessary_wraps)]
        pub(crate) fn backend(&self) -> Option<Box<dyn InputBackend>> {
            Some(Box::new(self.clone()))
        }
    }

    pub(crate) fn describe(input: &HeldInput) -> String {
        match input {
            HeldInput::Key(key) => format!("key {:#x}", key.scan_code),
            HeldInput::MouseButton(button) => format!("mouse {:?}", button.button),
            HeldInput::Axis(axis) => format!("axis {}={}", axis.axis, axis.value),
        }
    }

    fn describe_momentary(momentary: &Momentary) -> String {
        match momentary {
            Momentary::Click { x, y, button } => format!("click {button:?} at {x},{y}"),
            Momentary::Key { scan_code } => format!("press {scan_code:#x}"),
        }
    }

    impl InputBackend for Recorder {
        fn press(&mut self, input: &HeldInput) -> Inject {
            self.0
                .lock()
                .unwrap()
                .push(format!("down {}", describe(input)));
            Inject::Done
        }

        fn release(&mut self, input: &HeldInput) -> bool {
            self.0
                .lock()
                .unwrap()
                .push(format!("up {}", describe(input)));
            true
        }

        fn act(&mut self, action: &Action) -> Inject {
            let text = match action {
                Action::Click(click) => format!("click {} at {},{}", click.id, click.x, click.y),
                Action::KeyPress(press) => format!("press {} {:#x}", press.id, press.scan_code),
                Action::Scroll(scroll) => format!("scroll {} {}", scroll.id, scroll.notches),
                Action::MouseMove(moved) => format!("move {} {},{}", moved.id, moved.dx, moved.dy),
            };
            self.0.lock().unwrap().push(text);
            Inject::Done
        }

        fn begin_momentary(&mut self, momentary: &Momentary) -> Inject {
            self.0
                .lock()
                .unwrap()
                .push(format!("begin {}", describe_momentary(momentary)));
            Inject::Done
        }

        fn end_momentary(&mut self, momentary: &Momentary) -> bool {
            self.0
                .lock()
                .unwrap()
                .push(format!("end {}", describe_momentary(momentary)));
            true
        }

        fn released_all(&mut self, reason: ReleaseReason, _release_id: u64) {
            self.0
                .lock()
                .unwrap()
                .push(format!("release all {reason:?}"));
        }
    }

    pub(crate) fn key(scan_code: u16) -> HeldInput {
        HeldInput::Key(HeldKey { scan_code })
    }

    pub(crate) fn axis(name: &str, value: f64) -> HeldInput {
        HeldInput::Axis(HeldAxis {
            axis: name.into(),
            value,
        })
    }

    #[test]
    fn releasing_lifts_momentary_then_held_in_reverse_order() {
        let recorder = Recorder::default();
        let mut ledger = InputLedger::new(recorder.backend());
        ledger.press(key(0x11), 0);
        ledger.press(
            HeldInput::MouseButton(HeldMouseButton {
                button: MouseButton::Left,
            }),
            0,
        );
        ledger.begin_momentary(Momentary::Key { scan_code: 0x1C }, 100);
        ledger.release_all(ReleaseReason::LeaseExpired, 1);
        assert!(ledger.is_empty());
        assert_eq!(
            recorder.take(),
            [
                "down key 0x11",
                "down mouse Left",
                "begin press 0x1c",
                "end press 0x1c",
                "up mouse Left",
                "up key 0x11",
                "release all LeaseExpired",
            ]
        );
    }
}
