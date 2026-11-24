//! 急停组合键解析与触发判断（缺省 `Ctrl+Shift+F12`）。

use std::collections::BTreeSet;

/// 急停组合键：一组无边修饰键 + 一个最终键。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Combo {
    modifiers: BTreeSet<u16>,
    key: u16,
}

mod vk {
    pub(super) const CONTROL: u16 = 0x11;
    pub(super) const SHIFT: u16 = 0x10;
    pub(super) const ALT: u16 = 0x12;
    pub(super) const WIN: u16 = 0x5B;
    pub(super) const RWIN: u16 = 0x5C;
    pub(super) const LSHIFT: u16 = 0xA0;
    pub(super) const RSHIFT: u16 = 0xA1;
    pub(super) const LCONTROL: u16 = 0xA2;
    pub(super) const RCONTROL: u16 = 0xA3;
    pub(super) const LALT: u16 = 0xA4;
    pub(super) const RALT: u16 = 0xA5;
    pub(super) const END: u16 = 0x23;
    pub(super) const HOME: u16 = 0x24;
    pub(super) const INSERT: u16 = 0x2D;
    pub(super) const DELETE: u16 = 0x2E;
    pub(super) const ESCAPE: u16 = 0x1B;
    pub(super) const PAUSE: u16 = 0x13;
    pub(super) const SCROLL_LOCK: u16 = 0x91;
}

/// 将左右修饰键归并成无边虚拟键码。
#[must_use]
pub fn normalize_vk(code: u16) -> u16 {
    match code {
        vk::LSHIFT | vk::RSHIFT => vk::SHIFT,
        vk::LCONTROL | vk::RCONTROL => vk::CONTROL,
        vk::LALT | vk::RALT => vk::ALT,
        vk::RWIN => vk::WIN,
        other => other,
    }
}

fn modifier_vk(name: &str) -> Option<u16> {
    match name {
        "ctrl" | "control" => Some(vk::CONTROL),
        "shift" => Some(vk::SHIFT),
        "alt" => Some(vk::ALT),
        "win" | "super" | "meta" => Some(vk::WIN),
        _ => None,
    }
}

fn key_vk(name: &str) -> Option<u16> {
    if let Some(number) = name.strip_prefix('f')
        && let Ok(index) = number.parse::<u16>()
        && (1..=24).contains(&index)
    {
        return Some(0x6F + index);
    }
    if name.len() == 1 {
        let ch = name.chars().next()?;
        if ch.is_ascii_alphabetic() {
            return Some(ch.to_ascii_uppercase() as u16);
        }
        if ch.is_ascii_digit() {
            return Some(ch as u16);
        }
    }
    match name {
        "end" => Some(vk::END),
        "home" => Some(vk::HOME),
        "insert" | "ins" => Some(vk::INSERT),
        "delete" | "del" => Some(vk::DELETE),
        "escape" | "esc" => Some(vk::ESCAPE),
        "pause" => Some(vk::PAUSE),
        "scrolllock" => Some(vk::SCROLL_LOCK),
        _ => None,
    }
}

impl Combo {
    /// 缺省急停组合键 `Ctrl+Shift+F12`。
    #[must_use]
    pub fn default_hotkey() -> Self {
        Self {
            modifiers: [vk::CONTROL, vk::SHIFT].into_iter().collect(),
            key: 0x6F + 12,
        }
    }

    /// 解析形如 `ctrl+shift+f12`、`ctrl+alt+end` 的组合键。
    ///
    /// # Errors
    ///
    /// 缺少最终键、多于一个最终键、键名未知或重复修饰键时返回说明。
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut modifiers = BTreeSet::new();
        let mut key: Option<u16> = None;
        for part in text.split('+') {
            let name = part.trim().to_ascii_lowercase();
            if name.is_empty() {
                return Err(format!("emergency hotkey {text:?} has an empty part"));
            }
            if let Some(modifier) = modifier_vk(&name) {
                if !modifiers.insert(modifier) {
                    return Err(format!("emergency hotkey {text:?} repeats a modifier"));
                }
            } else if let Some(code) = key_vk(&name) {
                if key.is_some() {
                    return Err(format!(
                        "emergency hotkey {text:?} has more than one non-modifier key"
                    ));
                }
                key = Some(code);
            } else {
                return Err(format!(
                    "emergency hotkey {text:?} has an unknown key {name:?}"
                ));
            }
        }
        match key {
            Some(key) => Ok(Self { modifiers, key }),
            None => Err(format!(
                "emergency hotkey {text:?} needs a non-modifier key"
            )),
        }
    }

    /// 所有修饰键都已按下且刚按下的键等于最终键时触发。
    #[must_use]
    pub fn triggered(&self, final_key: u16, down: &BTreeSet<u16>) -> bool {
        normalize_vk(final_key) == self.key
            && self
                .modifiers
                .iter()
                .all(|modifier| down.iter().any(|vk| normalize_vk(*vk) == *modifier))
    }
}
