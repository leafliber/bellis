//! 低层钩子事件分类（真人接管、第三方注入、急停组合键）与钩子自检。

use std::collections::BTreeSet;

use super::backend::Event;
use super::hotkey::Combo;

/// 低层钩子看到的归一化原始事件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RawEvent {
    KeyDown { vk: u16 },
    KeyUp { vk: u16 },
    MouseDown,
    MouseUp,
    Wheel,
    MouseMove { dx: i32, dy: i32 },
    Other,
}

/// 钩子对事件的分类结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    OwnInjection,
    Takeover,
    Emergency,
    HookLost,
    Ignore,
}

/// 鼠标移动判真人接管的累计物理像素阈值（避开光电鼠标微小抖动）。
pub const MOVE_THRESHOLD_PX: i64 = 8;

/// 钩子分类状态：当前按住键集合（判急停）+ 鼠标移动累计（判真人移动）。
#[derive(Debug, Default)]
pub struct HookState {
    down: BTreeSet<u16>,
    movement: i64,
}

impl HookState {
    pub fn lease_became_valid(&mut self) {
        self.movement = 0;
    }

    pub fn classify(
        &mut self,
        event: RawEvent,
        injected: bool,
        own: bool,
        combo: &Combo,
        lease_valid: bool,
    ) -> Class {
        match event {
            RawEvent::KeyDown { vk } => {
                let emergency = combo.triggered(vk, &self.down);
                self.down.insert(vk);
                if emergency {
                    return Class::Emergency;
                }
            }
            RawEvent::KeyUp { vk } => {
                self.down.remove(&vk);
            }
            _ => {}
        }
        if injected && own {
            return match event {
                RawEvent::MouseMove { .. } | RawEvent::Other => Class::Ignore,
                _ => Class::OwnInjection,
            };
        }
        let human = match event {
            RawEvent::KeyUp { .. } | RawEvent::MouseUp | RawEvent::Other => false,
            RawEvent::MouseMove { dx, dy } if !injected => {
                self.movement += i64::from(dx.unsigned_abs()) + i64::from(dy.unsigned_abs());
                self.movement > MOVE_THRESHOLD_PX
            }
            _ => true,
        };
        if human && lease_valid {
            Class::Takeover
        } else {
            Class::Ignore
        }
    }
}

/// 钩子自检计数的事件数：排除 `MouseMoveAbs`，仅计键、鼠标键与滚轮。
#[must_use]
pub fn self_check_count(events: &[Event], sent: u32) -> u64 {
    let counted = events
        .iter()
        .take(sent as usize)
        .filter(|event| !matches!(event, Event::MouseMoveAbs { .. }))
        .count();
    counted as u64
}

/// 钩子自检状态：上一轮已注入的事件到本轮仍未经过钩子时判钩子失效。
#[derive(Debug, Default)]
pub struct SelfCheck {
    last_injected: u64,
    excused: u64,
}

impl SelfCheck {
    pub fn tick(&mut self, injected: u64, seen: u64) -> bool {
        let lost = self.last_injected > seen.saturating_add(self.excused);
        if lost {
            self.excused = self.last_injected - seen;
        }
        self.last_injected = injected;
        lost
    }
}
