//! 控制产出者心跳、代次吊销、输入策略配置与动作块校验提交。

use std::collections::HashSet;

use super::plan::{Current, Outcomes, action_id, nanos};
use super::state::State;
use super::{Configured, Control, Notices, Rejection};
use crate::capture::FrameStatus;
use crate::input::{HeldId, Policy};
use crate::protocol::{
    Accepted, ActionBlock, ActionSubmitResult, HeldInput, InputPolicy, ProducerHeartbeatParams,
    RejectReason, Rejected, ReleaseReason,
};

/// 动作块静态内容规则校验。
///
/// # Errors
///
/// 步为空、偏移倒序、时刻溢出/超截止、同一步持键重复、轴值越界或动作 id 重复时返回说明。
pub fn check_block(block: &ActionBlock) -> Result<(), String> {
    if block.steps.is_empty() {
        return Err("an action block needs at least one step".into());
    }
    let mut previous = 0;
    let mut ids = HashSet::new();
    for (index, step) in block.steps.iter().enumerate() {
        if step.offset_ns < previous {
            return Err(format!("step {index}: offset_ns goes backwards"));
        }
        previous = step.offset_ns;
        let Some(at) = block.start_ns.checked_add(step.offset_ns) else {
            return Err(format!("step {index}: start_ns + offset_ns overflows"));
        };
        if at > block.deadline_ns {
            return Err(format!("step {index}: takes effect after deadline_ns"));
        }
        let mut held = HashSet::new();
        for input in &step.held {
            if !held.insert(HeldId::of(input)) {
                return Err(format!(
                    "step {index}: {:?} is held twice",
                    HeldId::of(input)
                ));
            }
            if let HeldInput::Axis(axis) = input
                && !(-1.0..=1.0).contains(&axis.value)
            {
                return Err(format!(
                    "step {index}: axis {} value {} is outside [-1, 1]",
                    axis.axis, axis.value
                ));
            }
        }
        for action in &step.actions {
            if !ids.insert(action_id(action)) {
                return Err(format!(
                    "step {index}: action id {} repeats",
                    action_id(action)
                ));
            }
        }
    }
    Ok(())
}

fn rejected(reason: RejectReason, message: impl Into<String>) -> ActionSubmitResult {
    ActionSubmitResult::Rejected(Rejected {
        reason,
        message: message.into(),
    })
}

impl Control {
    /// `producer.heartbeat`。
    ///
    /// # Errors
    ///
    /// 代次陈旧/已作废、身份不符、序号倒退或停止中返回 [`Rejection`]。
    pub fn heartbeat(
        &self,
        heartbeat: &ProducerHeartbeatParams,
        now: u64,
    ) -> Result<Notices, Rejection> {
        let mut state = self.lock();
        if state.stopping {
            return Err(Rejection::Stopping);
        }
        let producer = &heartbeat.producer;
        if state
            .revoked_through
            .is_some_and(|revoked| producer.generation <= revoked)
        {
            return Err(Rejection::Revoked);
        }
        let deadline = Some(now.saturating_add(nanos(self.limits.heartbeat_timeout)));
        let mut notices = Notices::default();
        match &mut state.current {
            Some(current) if producer.generation < current.producer.generation => {
                return Err(Rejection::StaleGeneration);
            }
            Some(current) if producer.generation == current.producer.generation => {
                if producer.id != current.producer.id {
                    return Err(Rejection::ProducerMismatch);
                }
                if current.last_seq.is_some_and(|last| heartbeat.seq <= last) {
                    return Err(Rejection::StaleSeq);
                }
                current.last_seq = Some(heartbeat.seq);
                current.deadline = deadline;
            }
            _ => {
                if state.current.is_some() {
                    state.release_current(ReleaseReason::ProducerChanged, &mut notices);
                }
                let mut current = Current::new(producer.clone());
                current.last_seq = Some(heartbeat.seq);
                current.deadline = deadline;
                state.current = Some(current);
            }
        }
        self.done(state);
        Ok(notices)
    }

    /// `producer.revoke`。
    #[must_use]
    pub fn revoke(&self, generation: u64) -> (Option<u64>, Notices) {
        let mut state = self.lock();
        let previous_release = state.last_release_id;
        let mut notices = Notices::default();
        state.revoke_through(generation, &mut notices);
        let has_release = state.last_release_id != previous_release
            || state.verifies_release && state.current.is_none() && state.last_release_id > 0;
        let release_id = has_release.then_some(state.last_release_id);
        self.done(state);
        (release_id, notices)
    }

    /// 采集源变更或失效时，在控制锁内同步清空旧帧并作废当前产出者代次。
    #[must_use]
    pub fn capture_reset(&self) -> Notices {
        let mut state = self.lock();
        self.frames.forget();
        let mut notices = Notices::default();
        if let Some(producer) = state.current_producer() {
            state.revoke_through(producer.generation, &mut notices);
        }
        self.done(state);
        notices
    }

    /// `input.configure`：每实例一次，不可覆盖。
    ///
    /// # Errors
    ///
    /// 策略参数非法时返回错误说明（映射为 `-32602`）。
    pub fn configure(&self, params: &InputPolicy) -> Result<Configured, String> {
        let mut state = self.lock();
        if state.policy.is_some() {
            return Ok(Configured::Conflict);
        }
        let policy = Policy::parse(params)?;
        state.policy = Some(policy);
        state.ledger.configured(params);
        self.done(state);
        Ok(Configured::Accepted)
    }

    /// `action.submit`：先处理到 `now` 为止的到期项，再校验并装入计划。
    #[must_use]
    pub fn submit(&self, block: ActionBlock, now: u64) -> (ActionSubmitResult, Notices) {
        let mut state = self.lock();
        let mut notices = Notices::default();
        state.tick(now, &self.frames, &self.limits, &mut notices);
        let result = Self::accept(&mut state, block, now, &self.frames, &mut notices);
        self.done(state);
        (result, notices)
    }

    fn accept(
        state: &mut State,
        block: ActionBlock,
        now: u64,
        frames: &FrameStatus,
        notices: &mut Notices,
    ) -> ActionSubmitResult {
        if state.stopping {
            return rejected(RejectReason::Stopping, "the core is stopping");
        }
        let producer = &block.producer;
        if let Some(revoked) = state.revoked_through
            && producer.generation <= revoked
        {
            return rejected(
                RejectReason::StaleGeneration,
                format!(
                    "generation {} is revoked (up to {revoked})",
                    producer.generation
                ),
            );
        }
        let same_generation = match &state.current {
            Some(current) if producer.generation < current.producer.generation => {
                return rejected(
                    RejectReason::StaleGeneration,
                    format!(
                        "generation {} is older than the current generation {}",
                        producer.generation, current.producer.generation
                    ),
                );
            }
            Some(current) if producer.generation == current.producer.generation => {
                if producer.id != current.producer.id {
                    return rejected(
                        RejectReason::ProducerMismatch,
                        format!(
                            "generation {} belongs to {:?}, not {:?}",
                            producer.generation, current.producer.id, producer.id
                        ),
                    );
                }
                Some(current.last_block_seq)
            }
            _ => None,
        };
        if let Err(message) = check_block(&block) {
            return rejected(RejectReason::Invalid, message);
        }
        if let Err(message) = Self::check_whitelist(state, &block) {
            return rejected(RejectReason::NotAllowed, message);
        }
        if let Some(Some(last)) = same_generation
            && block.seq <= last
        {
            return rejected(
                RejectReason::StaleSeq,
                format!("seq {} is not after {last}", block.seq),
            );
        }
        if block.deadline_ns <= now {
            return rejected(
                RejectReason::Expired,
                format!("deadline_ns {} is not after now ({now})", block.deadline_ns),
            );
        }
        if block
            .steps
            .iter()
            .any(|step| !step.held.is_empty() || !step.actions.is_empty())
        {
            if state.input_unavailable() {
                return rejected(
                    RejectReason::NotAllowed,
                    "input release has not been verified",
                );
            }
            if state.requires_policy && !frames.contains_frame(block.base_frame) {
                return rejected(
                    RejectReason::NotAllowed,
                    "the base frame is outside the current capture",
                );
            }
        }
        if same_generation.is_none() {
            if state.current.is_some()
                && !state.release_current(ReleaseReason::ProducerChanged, notices)
            {
                return rejected(
                    RejectReason::NotAllowed,
                    "input release failed during producer change",
                );
            }
            state.current = Some(Current::new(producer.clone()));
        }
        if let Some(current) = state.current.as_mut() {
            current.last_block_seq = Some(block.seq);
        }
        let producer = producer.clone();
        let mut superseded = Outcomes::default();
        state.plan.install(block, &mut superseded);
        superseded.emit(Some(&producer), notices);
        ActionSubmitResult::Accepted(Accepted {})
    }

    fn check_whitelist(state: &State, block: &ActionBlock) -> Result<(), String> {
        match &state.policy {
            Some(policy) => {
                for step in &block.steps {
                    for held in &step.held {
                        policy.allows_held(held).map_err(|error| error.0)?;
                    }
                    for action in &step.actions {
                        policy.allows_action(action).map_err(|error| error.0)?;
                    }
                }
                Ok(())
            }
            None if state.requires_policy => {
                let has_input = block
                    .steps
                    .iter()
                    .any(|step| !step.held.is_empty() || !step.actions.is_empty());
                if has_input {
                    Err("the real input backend has no input policy yet".into())
                } else {
                    Ok(())
                }
            }
            None => Ok(()),
        }
    }
}
