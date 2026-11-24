//! 输入策略：动作白名单、静态禁区、速率上限与最长按住时长。

use std::collections::HashSet;
use std::time::Duration;

use crate::protocol::{Action, HeldInput, InputPolicy, MouseButton, NormRect};

#[derive(Clone, Copy, Debug)]
struct Rect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Rect {
    fn parse(index: usize, field: &str, rect: &NormRect) -> Result<Self, String> {
        let valid = [rect.left, rect.top, rect.right, rect.bottom]
            .iter()
            .all(|v| v.is_finite() && (0.0..=1.0).contains(v));
        if !(valid && rect.left < rect.right && rect.top < rect.bottom) {
            return Err(format!(
                "{field}[{index}] 不是 [0, 1] 内左上小于右下的归一化矩形"
            ));
        }
        Ok(Self {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        })
    }

    fn contains(&self, x: f64, y: f64) -> bool {
        self.left <= x && x < self.right && self.top <= y && y < self.bottom
    }
}

/// 核对过的输入策略。
#[derive(Debug)]
pub struct Policy {
    click_buttons: HashSet<MouseButton>,
    press_keys: HashSet<u16>,
    scroll: bool,
    click_regions: Vec<Rect>,
    forbidden_zones: Vec<Rect>,
    press_duration: Duration,
    max_rate: f64,
    hold_keys: HashSet<u16>,
    hold_buttons: HashSet<MouseButton>,
    max_hold: Option<Duration>,
}

/// 提交时持续状态或一次性动作不在白名单内。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotAllowed(pub String);

impl Policy {
    /// 核对 [`InputPolicy`]；不合规则返回说明（映射为 `-32602`）。
    ///
    /// # Errors
    ///
    /// 参数越界或前后矛盾时返回错误说明。
    pub fn parse(policy: &InputPolicy) -> Result<Self, String> {
        if !(1..=500).contains(&policy.press_duration_ms) {
            return Err(format!(
                "press_duration_ms 须在 1 到 500 之间，得到 {}",
                policy.press_duration_ms
            ));
        }
        if !(policy.max_rate.is_finite() && policy.max_rate > 0.0) {
            return Err(format!("max_rate 须大于 0，得到 {}", policy.max_rate));
        }
        let mut click_regions = Vec::with_capacity(policy.click_regions.len());
        for (index, rect) in policy.click_regions.iter().enumerate() {
            click_regions.push(Rect::parse(index, "click_regions", rect)?);
        }
        let mut forbidden_zones = Vec::with_capacity(policy.forbidden_zones.len());
        for (index, rect) in policy.forbidden_zones.iter().enumerate() {
            forbidden_zones.push(Rect::parse(index, "forbidden_zones", rect)?);
        }
        if (!policy.click_buttons.is_empty() || policy.scroll) && click_regions.is_empty() {
            return Err("允许点击或滚动时 click_regions 不能为空".into());
        }
        let allows_hold = !policy.hold_keys.is_empty() || !policy.hold_buttons.is_empty();
        if allows_hold != policy.max_hold_ms.is_some() {
            return Err("有可按住的项时必须给出 max_hold_ms，没有时须为 null".into());
        }
        if policy.max_hold_ms == Some(0) {
            return Err("max_hold_ms 须大于 0".into());
        }
        Ok(Self {
            click_buttons: policy.click_buttons.iter().copied().collect(),
            press_keys: policy.press_keys.iter().copied().collect(),
            scroll: policy.scroll,
            click_regions,
            forbidden_zones,
            press_duration: Duration::from_millis(u64::from(policy.press_duration_ms)),
            max_rate: policy.max_rate,
            hold_keys: policy.hold_keys.iter().copied().collect(),
            hold_buttons: policy.hold_buttons.iter().copied().collect(),
            max_hold: policy
                .max_hold_ms
                .map(|ms| Duration::from_millis(u64::from(ms))),
        })
    }

    #[must_use]
    pub fn press_duration(&self) -> Duration {
        self.press_duration
    }

    #[must_use]
    pub fn max_hold(&self) -> Option<Duration> {
        self.max_hold
    }

    #[must_use]
    pub fn within_rate(&self, recent: usize) -> bool {
        f64::from(u32::try_from(recent).unwrap_or(u32::MAX)) < self.max_rate
    }

    /// 持续状态的一项是否在白名单内。
    ///
    /// # Errors
    ///
    /// 不在白名单内返回 [`NotAllowed`]。
    pub fn allows_held(&self, input: &HeldInput) -> Result<(), NotAllowed> {
        match input {
            HeldInput::Key(key) if self.hold_keys.contains(&key.scan_code) => Ok(()),
            HeldInput::Key(key) => Err(NotAllowed(format!(
                "扫描码 {:#x} 不在 hold_keys 内",
                key.scan_code
            ))),
            HeldInput::MouseButton(button) if self.hold_buttons.contains(&button.button) => Ok(()),
            HeldInput::MouseButton(button) => Err(NotAllowed(format!(
                "鼠标键 {:?} 不在 hold_buttons 内",
                button.button
            ))),
            HeldInput::Axis(axis) => Err(NotAllowed(format!("不允许轴 {}", axis.axis))),
        }
    }

    /// 一次性动作种类是否在白名单内。
    ///
    /// # Errors
    ///
    /// 不在白名单内返回 [`NotAllowed`]。
    pub fn allows_action(&self, action: &Action) -> Result<(), NotAllowed> {
        match action {
            Action::Click(click) if self.click_buttons.contains(&click.button) => Ok(()),
            Action::Click(click) => Err(NotAllowed(format!(
                "鼠标键 {:?} 不在 click_buttons 内",
                click.button
            ))),
            Action::KeyPress(press) if self.press_keys.contains(&press.scan_code) => Ok(()),
            Action::KeyPress(press) => Err(NotAllowed(format!(
                "扫描码 {:#x} 不在 press_keys 内",
                press.scan_code
            ))),
            Action::Scroll(_) if self.scroll => Ok(()),
            Action::Scroll(_) => Err(NotAllowed("不允许滚动".into())),
            Action::MouseMove(_) => Err(NotAllowed("不允许相对位移".into())),
        }
    }

    /// 执行时核对带坐标动作的落点：须在某个 `click_regions` 内且不在任何 `forbidden_zones` 内。
    #[must_use]
    pub fn point_allowed(&self, x: u32, y: u32, width: u32, height: u32) -> bool {
        if width == 0 || height == 0 {
            return false;
        }
        let nx = f64::from(x) / f64::from(width);
        let ny = f64::from(y) / f64::from(height);
        let in_region = self.click_regions.iter().any(|r| r.contains(nx, ny));
        let forbidden = self.forbidden_zones.iter().any(|r| r.contains(nx, ny));
        in_region && !forbidden
    }
}

#[cfg(test)]
mod tests {
    use super::Policy;
    use crate::protocol::{
        Action, Click, HeldAxis, HeldInput, HeldKey, HeldMouseButton, InputPolicy, KeyPress,
        MouseButton, MouseMove, NormRect, Scroll,
    };

    fn rect(left: f64, top: f64, right: f64, bottom: f64) -> NormRect {
        NormRect {
            left,
            top,
            right,
            bottom,
        }
    }

    fn base() -> InputPolicy {
        InputPolicy {
            click_buttons: vec![MouseButton::Left],
            press_keys: vec![0x1C],
            scroll: true,
            click_regions: vec![rect(0.25, 0.25, 0.75, 0.75)],
            forbidden_zones: vec![rect(0.4, 0.4, 0.6, 0.6)],
            press_duration_ms: 50,
            max_rate: 2.0,
            hold_keys: vec![0x11],
            hold_buttons: vec![MouseButton::Right],
            max_hold_ms: Some(2000),
        }
    }

    #[test]
    fn validates_policy_bounds_and_enforces_whitelist_regions_and_rate() {
        let mut bad = base();
        bad.press_duration_ms = 0;
        assert!(Policy::parse(&bad).is_err());
        let mut bad = base();
        bad.max_hold_ms = None;
        assert!(Policy::parse(&bad).is_err());

        let policy = Policy::parse(&base()).unwrap();
        assert!(
            policy
                .allows_held(&HeldInput::Key(HeldKey { scan_code: 0x11 }))
                .is_ok()
        );
        assert!(
            policy
                .allows_held(&HeldInput::MouseButton(HeldMouseButton {
                    button: MouseButton::Right
                }))
                .is_ok()
        );
        assert!(
            policy
                .allows_held(&HeldInput::Axis(HeldAxis {
                    axis: "yaw".into(),
                    value: 0.0
                }))
                .is_err()
        );
        assert!(
            policy
                .allows_action(&Action::Click(Click {
                    id: 1,
                    x: 0,
                    y: 0,
                    button: MouseButton::Left
                }))
                .is_ok()
        );
        assert!(
            policy
                .allows_action(&Action::KeyPress(KeyPress {
                    id: 2,
                    scan_code: 0x1C
                }))
                .is_ok()
        );
        assert!(
            policy
                .allows_action(&Action::Scroll(Scroll {
                    id: 3,
                    x: 0,
                    y: 0,
                    notches: 1
                }))
                .is_ok()
        );
        assert!(
            policy
                .allows_action(&Action::MouseMove(MouseMove {
                    id: 4,
                    dx: 1,
                    dy: 1
                }))
                .is_err()
        );
        assert!(policy.point_allowed(30, 30, 100, 100));
        assert!(!policy.point_allowed(50, 50, 100, 100));
        assert!(!policy.point_allowed(10, 10, 100, 100));
        assert!(policy.within_rate(1));
        assert!(!policy.within_rate(2));
    }
}
