//! 控制状态的统一许可操作、带外急停与物理残留核验门禁。

use std::sync::PoisonError;
use std::time::Duration;

use super::lease::{Granted, Refusal};
use super::state::State;
use super::{Control, LeaseGrant, Notices};
use crate::clock;
use crate::protocol::{
    HeldInput, InputReleasedParams, LeaseRenewParams, ReleaseReason, ReleaseVerification,
};

impl Control {
    /// 只核验当前释放；若补发抬起被拒则在同一把锁内本地撤权并锁存故障。
    pub(crate) fn with_verification<T>(
        &self,
        release_id: u64,
        check: impl FnOnce() -> (T, bool),
    ) -> Option<T> {
        let mut state = self.lock();
        if state.pending_verification_id() != Some(release_id) {
            return None;
        }
        let (observed, repair_rejected) = check();
        if repair_rejected {
            state.latch_input_fault(Refusal::ReleaseFailed);
        }
        Some(observed)
    }

    /// 完成一次物理核验并生成统一的 `InputReleasedParams` 核验通知。
    pub(crate) fn finish_verification(
        &self,
        release_id: u64,
        reason: ReleaseReason,
        observed: ReleaseVerification,
        residual_items: Vec<HeldInput>,
    ) -> InputReleasedParams {
        let mut state = self.lock();
        let (token, producer, verification) = if let Some(pending) =
            state.pending_verification.as_ref()
            && pending.release_id == release_id
        {
            let token = pending.token;
            let producer = pending.producer.clone();
            let verification = match observed {
                ReleaseVerification::Verified if state.input_fault.is_some() => {
                    ReleaseVerification::Unavailable
                }
                ReleaseVerification::Residual | ReleaseVerification::Unavailable => {
                    state.latch_input_fault(Refusal::ReleaseFailed);
                    observed
                }
                _ => observed,
            };
            (token, producer, verification)
        } else {
            (None, None, ReleaseVerification::Superseded)
        };
        let released_at_ns = clock::now_ns();
        self.done(state);
        InputReleasedParams {
            release_id,
            token,
            reason,
            producer,
            released_at_ns,
            verification,
            residual_items,
        }
    }

    /// 核验结果入队发送后才放开对应的门禁。
    pub(crate) fn verification_posted(&self, release_id: u64, verification: ReleaseVerification) {
        let mut state = self.lock();
        if state
            .last_verification_posted
            .is_none_or(|(last_id, _)| last_id < release_id)
        {
            state.last_verification_posted = Some((release_id, verification));
        }
        if state.pending_verification_id() == Some(release_id) {
            state.pending_verification = None;
        }
        self.done(state);
    }

    /// 退出前在有限时限内等待最后一次释放完成物理核验。
    #[must_use]
    pub fn wait_for_final_verification(&self, timeout: Duration) -> bool {
        let has_report = |state: &State| {
            state.last_verification_posted.map_or(0, |(id, _)| id) == state.last_release_id
        };
        let (state, _) = self
            .changed
            .wait_timeout_while(self.lock(), timeout, |state| {
                state.verifies_release && !has_report(state)
            })
            .unwrap_or_else(PoisonError::into_inner);
        state.input_fault.is_none() && (!state.verifies_release || has_report(&state))
    }

    pub(crate) fn grant_lease(
        &self,
        grant: &LeaseRenewParams,
        read_clock: impl Fn() -> u64,
    ) -> (Result<LeaseGrant, Refusal>, Notices) {
        let mut state = self.lock();
        let mut notices = Notices::default();
        let result = state.grant_lease(grant, read_clock, &mut notices);
        self.done(state);
        (result, notices)
    }

    pub(crate) fn wait_for_lease_proof(&self, release_id: u64) -> Result<(), Refusal> {
        let (state, _) = self
            .changed
            .wait_timeout_while(self.lock(), Duration::from_millis(200), |state| {
                !state.stopping
                    && state.input_fault.is_none()
                    && state.last_release_id == release_id
                    && state.pending_verification_id() == Some(release_id)
            })
            .unwrap_or_else(PoisonError::into_inner);
        state.require_verified_release(release_id)
    }

    pub(crate) fn confirm_lease_grant(
        &self,
        grant: &LeaseRenewParams,
        release_id: u64,
        read_clock: impl FnOnce() -> u64,
    ) -> Result<(), Refusal> {
        let mut state = self.lock();
        state.require_verified_release(release_id)?;
        let now = read_clock();
        if state.check_lease_grant(grant, now)? != Granted::New {
            return Err(Refusal::ReleaseFailed);
        }
        state.lease.grant(grant.token, grant.expires_ns, now)?;
        self.done(state);
        Ok(())
    }

    /// `lease.revoke`：单调吊销 `token` 及更早令牌，吊销有效许可时立即释放。
    #[must_use]
    pub fn revoke_lease(&self, token: u64, read_clock: impl FnOnce() -> u64) -> Notices {
        let mut state = self.lock();
        let mut notices = Notices::default();
        state.expire_lease(read_clock(), &mut notices);
        let previous = state.lease.active_token();
        if state.lease.revoke(token) {
            state.release_current_for_token(ReleaseReason::LeaseRevoked, previous, &mut notices);
        }
        self.done(state);
        notices
    }

    /// `input.stop`：带外急停或按令牌水位显式停止；返回本次释放编号与通知。
    #[must_use]
    pub fn stop_input(
        &self,
        through_token: Option<u64>,
        read_clock: impl FnOnce() -> u64,
    ) -> (Option<u64>, Notices) {
        let mut state = self.lock();
        let mut notices = Notices::default();
        let mut release_id = None;
        if !state.stopping {
            state.expire_lease(read_clock(), &mut notices);
            match through_token {
                None => {
                    let prev = state.lease.active_token();
                    state.lease.local_revoke();
                    state.release_current_for_token(ReleaseReason::InputStop, prev, &mut notices);
                    release_id = Some(state.last_release_id);
                }
                Some(through) => {
                    let newer = state
                        .lease
                        .active_token()
                        .is_some_and(|token| token > through);
                    state.lease.revoke(through);
                    if !newer {
                        state.release_current_for_token(
                            ReleaseReason::InputStop,
                            (through != 0).then_some(through),
                            &mut notices,
                        );
                        release_id = Some(state.last_release_id);
                    }
                }
            }
        }
        self.done(state);
        (release_id, notices)
    }

    /// 钩子线程触发的本地撤权（接管、急停组合键、钩子失效）。
    #[must_use]
    pub fn local_revoke(&self, reason: ReleaseReason) -> Notices {
        let mut state = self.lock();
        let mut notices = Notices::default();
        let hook_lost = reason == ReleaseReason::HookLost;
        if !(state.stopping || hook_lost && state.input_fault.is_some()) {
            let token = state.lease.active_token();
            if hook_lost {
                state.latch_input_fault(Refusal::HookLost);
            } else {
                state.lease.local_revoke();
            }
            state.release_current_for_token(reason, token, &mut notices);
        }
        self.done(state);
        notices
    }

    #[must_use]
    pub fn lease_valid(&self) -> bool {
        self.lock().lease.check(clock::now_ns()).is_ok()
    }

    #[must_use]
    pub fn lease_source_lost(&self) -> Notices {
        let mut state = self.lock();
        let mut notices = Notices::default();
        let token = state.lease.active_token();
        if !state.stopping && state.lease.source_lost() {
            state.release_current_for_token(ReleaseReason::LeaseSourceLost, token, &mut notices);
        }
        self.done(state);
        notices
    }
}
