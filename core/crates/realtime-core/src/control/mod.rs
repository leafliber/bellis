//! 确定性控制状态：三方输入权威、动作块校验与调度、统一许可管理与 Fail-Closed 释放。
//!
//! 全部状态受单一 `Mutex` 保护：每次状态变更都在锁内先完成物理抬起，再把通知（[`Notices`]）交回
//! 调用方在锁外异步投递，释放路径绝不等网络写入也不碰采集锁。

mod execute;
pub(crate) mod lease;
mod permit;
mod plan;
mod state;
mod submit;

pub use submit::check_block;

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use crate::capture::FrameStatus;
use crate::clock;
use crate::input::{InputBackend, InputLedger, Policy};
use crate::protocol::{
    ActionReceiptParams, CaptureState, HealthParams, InputReleasedParams, ReleaseReason,
};

use lease::Lease;
use plan::{Outcomes, Plan, nanos};
use state::State;

/// `input.configure` 的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Configured {
    Accepted,
    Conflict,
}

/// 心跳被忽略的原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
    Revoked,
    StaleGeneration,
    ProducerMismatch,
    StaleSeq,
    Stopping,
}

/// 控制状态的时限。
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub heartbeat_timeout: Duration,
    pub max_frame_age: Duration,
}

/// 锁内产生的通知集合，由调用方在锁外投递。
#[derive(Debug, Default)]
pub struct Notices(pub Vec<Notice>);

#[derive(Debug)]
pub enum Notice {
    Released(InputReleasedParams),
    Receipt(ActionReceiptParams),
}

impl Notices {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn released(&self) -> Vec<ReleaseReason> {
        self.0
            .iter()
            .filter_map(|notice| match notice {
                Notice::Released(released) => Some(released.reason),
                Notice::Receipt(_) => None,
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn receipts(&self) -> Vec<&ActionReceiptParams> {
        self.0
            .iter()
            .filter_map(|notice| match notice {
                Notice::Receipt(receipt) => Some(receipt),
                Notice::Released(_) => None,
            })
            .collect()
    }
}

/// 可立即应答的许可续约，或须等待某次旧许可物理核验完成的请求。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LeaseGrant {
    Applied,
    Verifying(u64),
}

/// 实时核的控制状态，供核连接读线程、调度线程、许可连接线程、健康线程与钩子线程共享。
pub struct Control {
    limits: Limits,
    state: Mutex<State>,
    changed: Condvar,
    frames: Arc<FrameStatus>,
}

impl Control {
    #[must_use]
    pub fn new(
        limits: Limits,
        frames: Arc<FrameStatus>,
        backend: Option<Box<dyn InputBackend>>,
        requires_policy: bool,
    ) -> Self {
        let has_source = backend.is_some();
        let verifies_release = backend
            .as_ref()
            .is_some_and(|backend| backend.verifies_release());
        Self {
            limits,
            state: Mutex::new(State {
                ledger: InputLedger::new(backend),
                lease: Lease::new(has_source),
                current: None,
                revoked_through: None,
                stopping: false,
                input_fault: None,
                last_release_id: 0,
                verifies_release,
                pending_verification: None,
                last_verification_posted: None,
                plan: Plan::default(),
                policy: None,
                requires_policy,
                rate: VecDeque::new(),
            }),
            changed: Condvar::new(),
            frames,
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn done(&self, state: MutexGuard<'_, State>) {
        drop(state);
        self.changed.notify_all();
    }

    /// 启动时先全量释放（`core_start`）。
    ///
    /// # Panics
    ///
    /// 不会 panic：`release` 始终发出释放通知。
    #[must_use]
    pub fn release_on_start(&self) -> InputReleasedParams {
        let mut notices = Notices::default();
        self.lock().release(
            ReleaseReason::CoreStart,
            None,
            Outcomes::default(),
            &mut notices,
        );
        match notices.0.into_iter().next() {
            Some(Notice::Released(released)) => released,
            _ => unreachable!("release always emits InputReleasedParams first"),
        }
    }

    #[cfg(test)]
    pub(crate) fn tick(&self, now: u64) -> Notices {
        let mut state = self.lock();
        let mut notices = Notices::default();
        state.tick(now, &self.frames, &self.limits, &mut notices);
        self.done(state);
        notices
    }

    #[must_use]
    pub fn shutdown(&self) -> Notices {
        self.release_and_stop(ReleaseReason::Shutdown)
    }

    #[must_use]
    pub fn release_on_exit(&self, reason: ReleaseReason) -> Notices {
        self.release_and_stop(reason)
    }

    fn release_and_stop(&self, reason: ReleaseReason) -> Notices {
        let mut state = self.lock();
        let mut notices = Notices::default();
        let producer = state.current.take().map(|c| c.producer);
        state.release(reason, producer.as_ref(), Outcomes::default(), &mut notices);
        state.stopping = true;
        self.done(state);
        notices
    }

    /// 采集当前健康快照（先读时钟再读状态；音频字段由会话层补齐）。
    #[must_use]
    pub fn health(&self) -> HealthParams {
        let now_ns = clock::now_ns();
        let (capture, latest_frame) = self.frames.snapshot();
        let state = self.lock();
        let queue_depth = u32::try_from(state.plan.entries.len()).unwrap_or(u32::MAX);
        HealthParams {
            now_ns,
            capture,
            audio: CaptureState::Idle,
            inputs_held: !state.ledger.is_empty(),
            producer: state.current_producer(),
            latest_frame,
            latest_audio: None,
            lease: state.lease.status(now_ns),
            queue_depth,
        }
    }

    fn next_wake(&self, state: &State) -> Option<u64> {
        let frame_stale_at = (!state.ledger.is_empty()).then(|| {
            self.frames.latest_capture_ns().map_or(0, |capture_ns| {
                capture_ns
                    .saturating_add(nanos(self.limits.max_frame_age))
                    .saturating_add(1)
            })
        });
        let max_hold_at = state
            .policy
            .as_ref()
            .and_then(Policy::max_hold)
            .zip(state.ledger.earliest_held_ns())
            .map(|(max_hold, pressed)| pressed.saturating_add(nanos(max_hold)));
        let next_entry = state
            .plan
            .entries
            .front()
            .filter(|_| !state.input_unavailable());
        [
            state.current.as_ref().and_then(|c| c.deadline),
            state.lease.expires_at(),
            next_entry.map(|entry| entry.at_ns),
            state.plan.active.map(|a| a.deadline_ns),
            frame_stale_at,
            state.ledger.next_lift(),
            max_hold_at,
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// 调度线程循环：按时刻执行动作步并触发全部定时释放，直到停止。
    pub fn run_scheduler(&self, mut send: impl FnMut(Notices)) {
        let mut state = self.lock();
        loop {
            if state.stopping {
                return;
            }
            let now = clock::now_ns();
            let mut notices = Notices::default();
            state.tick(now, &self.frames, &self.limits, &mut notices);
            if !notices.is_empty() {
                drop(state);
                send(notices);
                state = self.lock();
                continue;
            }
            state = match self.next_wake(&state) {
                None => self
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner),
                Some(at) if at <= now => continue,
                Some(at) => {
                    self.changed
                        .wait_timeout(state, Duration::from_nanos(at - now))
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
            };
        }
    }

    #[must_use]
    pub fn wait_stopping(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self.lock();
        while !state.stopping {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            state = self
                .changed
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        true
    }
}

#[cfg(test)]
mod tests;
