//! 控制状态的内部状态机：许可、权威检查、定时清理与 Fail-Closed 全量释放。

use std::collections::VecDeque;

use super::lease::{Granted, Lease, Refusal};
use super::plan::{Current, Outcomes, Plan, nanos};
use super::{LeaseGrant, Limits, Notice, Notices};
use crate::capture::FrameStatus;
use crate::clock;
use crate::input::{InputLedger, Policy};
use crate::protocol::{
    InputReleasedParams, LeaseRenewParams, Producer, ReleaseReason, ReleaseVerification,
};

#[derive(Clone)]
pub(super) struct PendingVerification {
    pub(super) release_id: u64,
    pub(super) blocks_new_lease: bool,
    pub(super) token: Option<u64>,
    pub(super) producer: Option<Producer>,
}

pub(super) struct State {
    pub(super) ledger: InputLedger,
    pub(super) lease: Lease,
    pub(super) current: Option<Current>,
    pub(super) revoked_through: Option<u64>,
    pub(super) stopping: bool,
    pub(super) input_fault: Option<Refusal>,
    pub(super) last_release_id: u64,
    pub(super) verifies_release: bool,
    pub(super) pending_verification: Option<PendingVerification>,
    pub(super) last_verification_posted: Option<(u64, ReleaseVerification)>,
    pub(super) plan: Plan,
    pub(super) policy: Option<Policy>,
    pub(super) requires_policy: bool,
    pub(super) rate: VecDeque<u64>,
}

impl State {
    pub(super) fn input_unavailable(&self) -> bool {
        self.input_fault.is_some() || self.pending_verification.is_some()
    }

    pub(super) fn current_producer(&self) -> Option<Producer> {
        self.current.as_ref().map(|c| c.producer.clone())
    }

    pub(super) fn pending_verification_id(&self) -> Option<u64> {
        self.pending_verification
            .as_ref()
            .map(|release| release.release_id)
    }

    pub(super) fn release(
        &mut self,
        reason: ReleaseReason,
        producer: Option<&Producer>,
        first: Outcomes,
        notices: &mut Notices,
    ) -> bool {
        self.release_for_token(reason, producer, first, self.lease.active_token(), notices)
    }

    pub(super) fn release_for_token(
        &mut self,
        reason: ReleaseReason,
        producer: Option<&Producer>,
        first: Outcomes,
        token: Option<u64>,
        notices: &mut Notices,
    ) -> bool {
        self.last_release_id += 1;
        let release_id = self.last_release_id;
        let awaits_verification = self.verifies_release
            && (self.policy.is_some()
                || matches!(
                    reason,
                    ReleaseReason::CoreStart
                        | ReleaseReason::Shutdown
                        | ReleaseReason::StdinClosed
                        | ReleaseReason::CoreConnectionLost
                ));
        if awaits_verification {
            let blocks_new_lease = token.is_some()
                || self
                    .pending_verification
                    .as_ref()
                    .is_some_and(|pending| pending.blocks_new_lease);
            self.pending_verification = Some(PendingVerification {
                release_id,
                blocks_new_lease,
                token,
                producer: producer.cloned(),
            });
        }
        let accepted = self.ledger.release_all(reason, release_id);
        let verification = if accepted {
            ReleaseVerification::Unverified
        } else {
            self.latch_input_fault(Refusal::ReleaseFailed);
            ReleaseVerification::UpFailed
        };
        let released_at_ns = clock::now_ns();
        let mut outcomes = first;
        self.plan.clear(&mut outcomes);
        notices.0.push(Notice::Released(InputReleasedParams {
            release_id,
            token,
            reason,
            producer: producer.cloned(),
            released_at_ns,
            verification,
            residual_items: Vec::new(),
        }));
        outcomes.emit(producer, notices);
        accepted
    }

    pub(super) fn latch_input_fault(&mut self, fault: Refusal) {
        self.input_fault.get_or_insert(fault);
        self.lease.local_revoke();
    }

    pub(super) fn check_lease_grant(
        &self,
        grant: &LeaseRenewParams,
        now: u64,
    ) -> Result<Granted, Refusal> {
        if now == 0 {
            return Err(Refusal::ClockUnavailable);
        }
        if self.stopping {
            return Err(Refusal::NoSource);
        }
        if let Some(fault) = self.input_fault {
            return Err(fault);
        }
        self.lease.check_grant(grant.token, grant.expires_ns, now)
    }

    pub(super) fn grant_lease(
        &mut self,
        grant: &LeaseRenewParams,
        read_clock: impl Fn() -> u64,
        notices: &mut Notices,
    ) -> Result<LeaseGrant, Refusal> {
        let now = read_clock();
        if !self.stopping {
            self.expire_lease(now, notices);
        }
        let granted = self.check_lease_grant(grant, now)?;
        if granted == Granted::Replaced {
            let old_token = self.lease.active_token().ok_or(Refusal::NoSource)?;
            self.lease.revoke(old_token);
            if !self.release_current_for_token(
                ReleaseReason::LeaseRevoked,
                Some(old_token),
                notices,
            ) || (self.verifies_release
                && self.pending_verification_id() != Some(self.last_release_id))
            {
                return Err(Refusal::ReleaseFailed);
            }
        }
        if granted != Granted::Renewed
            && let Some(pending) = &self.pending_verification
            && pending.blocks_new_lease
        {
            return Ok(LeaseGrant::Verifying(pending.release_id));
        }
        let now = read_clock();
        self.check_lease_grant(grant, now)?;
        self.lease.grant(grant.token, grant.expires_ns, now)?;
        Ok(LeaseGrant::Applied)
    }

    pub(super) fn require_verified_release(&self, release_id: u64) -> Result<(), Refusal> {
        if self.stopping {
            return Err(Refusal::NoSource);
        }
        if let Some(fault) = self.input_fault {
            return Err(fault);
        }
        if self.last_release_id == release_id
            && self.pending_verification_id().is_none()
            && self.last_verification_posted.is_some_and(|(id, result)| {
                id == release_id && result == ReleaseVerification::Verified
            })
        {
            Ok(())
        } else {
            Err(Refusal::ReleaseFailed)
        }
    }

    pub(super) fn release_current(&mut self, reason: ReleaseReason, notices: &mut Notices) -> bool {
        self.release_current_for_token(reason, self.lease.active_token(), notices)
    }

    pub(super) fn release_current_for_token(
        &mut self,
        reason: ReleaseReason,
        token: Option<u64>,
        notices: &mut Notices,
    ) -> bool {
        let producer = self.current_producer();
        self.release_for_token(
            reason,
            producer.as_ref(),
            Outcomes::default(),
            token,
            notices,
        )
    }

    pub(super) fn revoke_through(&mut self, generation: u64, notices: &mut Notices) {
        let through = self
            .revoked_through
            .map_or(generation, |r| r.max(generation));
        self.revoked_through = Some(through);
        if self
            .current
            .as_ref()
            .is_some_and(|c| c.producer.generation <= through)
        {
            let producer = self.current.take().map(|c| c.producer);
            self.release(
                ReleaseReason::GenerationRevoked,
                producer.as_ref(),
                Outcomes::default(),
                notices,
            );
        }
    }

    pub(super) fn release_block(
        &mut self,
        reason: ReleaseReason,
        revoke: bool,
        first: Outcomes,
        notices: &mut Notices,
    ) {
        let token = self.lease.active_token();
        if revoke {
            self.lease.local_revoke();
        }
        let producer = self.current_producer();
        self.release_for_token(reason, producer.as_ref(), first, token, notices);
    }

    pub(super) fn prune_rate(&mut self, now: u64) {
        const WINDOW_NS: u64 = 1_000_000_000;
        while let Some(&front) = self.rate.front() {
            if now.saturating_sub(front) >= WINDOW_NS {
                self.rate.pop_front();
            } else {
                break;
            }
        }
    }

    /// 三方输入权威检查：有效输入许可 + 有效控制产出者心跳 + 帧龄未过期。
    pub(super) fn authority(
        &self,
        producer: &Producer,
        now: u64,
        frames: &FrameStatus,
        limits: &Limits,
    ) -> Result<(), ReleaseReason> {
        self.lease.check(now)?;
        match &self.current {
            Some(current) if current.producer == *producer => {
                if current.deadline.is_none_or(|deadline| now >= deadline) {
                    return Err(ReleaseReason::HeartbeatTimeout);
                }
            }
            _ => return Err(ReleaseReason::ProducerChanged),
        }
        if frame_is_fresh(frames, now, limits) {
            Ok(())
        } else {
            Err(ReleaseReason::FrameStale)
        }
    }

    pub(super) fn tick(
        &mut self,
        now: u64,
        frames: &FrameStatus,
        limits: &Limits,
        notices: &mut Notices,
    ) {
        if self.stopping {
            return;
        }
        if !self.ledger.lift_due(now) {
            let token = self.lease.active_token();
            self.lease.local_revoke();
            self.release_current_for_token(ReleaseReason::InjectionBlocked, token, notices);
            return;
        }
        if let Some(current) = self.current.as_mut()
            && current.deadline.is_some_and(|deadline| now >= deadline)
        {
            current.deadline = None;
            self.release_current(ReleaseReason::HeartbeatTimeout, notices);
        }
        self.expire_lease(now, notices);
        if !self.ledger.is_empty() && !frame_is_fresh(frames, now, limits) {
            self.release_current(ReleaseReason::FrameStale, notices);
        }
        if self.max_hold_exceeded(now) {
            self.release_current(ReleaseReason::MaxHold, notices);
        }
        self.run_due_entries(now, frames, limits, notices);
        if let Some(active) = self.plan.active
            && now >= active.deadline_ns
        {
            self.release_current(ReleaseReason::DeadlineExpired, notices);
        }
    }

    pub(super) fn expire_lease(&mut self, now: u64, notices: &mut Notices) {
        let token = self.lease.active_token();
        if self.lease.expire(now) {
            self.release_current_for_token(ReleaseReason::LeaseExpired, token, notices);
        }
    }

    fn max_hold_exceeded(&self, now: u64) -> bool {
        let Some(max_hold) = self.policy.as_ref().and_then(Policy::max_hold) else {
            return false;
        };
        let max_hold = nanos(max_hold);
        self.ledger
            .earliest_held_ns()
            .is_some_and(|pressed| now.saturating_sub(pressed) >= max_hold)
    }
}

fn frame_is_fresh(frames: &FrameStatus, now: u64, limits: &Limits) -> bool {
    let max_age = nanos(limits.max_frame_age);
    frames
        .latest_capture_ns()
        .is_some_and(|capture_ns| now.saturating_sub(capture_ns) <= max_age)
}
