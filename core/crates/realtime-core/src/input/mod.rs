//! 输入策略、持键账目、急停热键、低层钩子分类、薄 Win32 接缝与真实 `SendInput` 后端。

pub mod backend;
pub mod hook_logic;
pub mod hotkey;
pub mod ledger;
pub mod policy;
pub mod win32_hooks;
pub mod win32_send;

pub use backend::{
    Desktop, Event, PhysicalButton, SendInputBackend, Target, TargetWindow, VerifyKey, VerifyKeys,
    VerifyRequest, Win32, absolute, check_release, physical_button, verify_residual,
};
pub use hook_logic::{Class, HookState, MOVE_THRESHOLD_PX, RawEvent, SelfCheck, self_check_count};
pub use hotkey::{Combo, normalize_vk};
pub use ledger::{HeldId, Inject, InputBackend, InputLedger, Momentary};
pub use policy::{NotAllowed, Policy};

#[cfg(test)]
mod tests;
