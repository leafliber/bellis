//! 控制状态的动作步执行逻辑：权威检查、持键切换、一次性动作去重/几何/策略核对与注入。

use super::Limits;
use super::Notices;
use super::plan::{Entry, Outcomes, action_id, coordinates, dropped, has_coordinates, nanos};
use super::state::State;
use crate::capture::FrameStatus;
use crate::clock;
use crate::input::{Inject, Momentary};
use crate::protocol::{Action, ActionOutcome, DropReason, Executed, ReleaseReason, Uncertain};

enum Step {
    Done,
    Defer(u64),
    Release { reason: ReleaseReason, revoke: bool },
}

impl State {
    pub(super) fn run_due_entries(
        &mut self,
        now: u64,
        frames: &FrameStatus,
        limits: &Limits,
        notices: &mut Notices,
    ) {
        if self.input_unavailable() {
            return;
        }
        loop {
            let Some(front) = self.plan.entries.front() else {
                return;
            };
            if front.at_ns > now {
                return;
            }
            let active = self.plan.active.map(|a| a.seq);
            if now > front.deadline_ns && active == Some(front.block_seq) {
                return;
            }
            let mut entry = self.plan.entries.pop_front().expect("front checked");
            let late = now > entry.deadline_ns;
            match self.step(&mut entry, late, now, frames, limits) {
                Step::Done => {
                    let producer = self.current_producer();
                    let mut outcomes = Outcomes::default();
                    for outcome in entry.done {
                        outcomes.add(entry.block_seq, outcome);
                    }
                    outcomes.emit(producer.as_ref(), notices);
                }
                Step::Defer(at) => {
                    entry.at_ns = at;
                    self.plan.entries.push_front(entry);
                    return;
                }
                Step::Release { reason, revoke } => {
                    let mut first = Outcomes::default();
                    for outcome in &entry.done {
                        first.add(entry.block_seq, outcome.clone());
                    }
                    for action in &entry.actions {
                        first.add(entry.block_seq, dropped(action, DropReason::Released));
                    }
                    self.release_block(reason, revoke, first, notices);
                    return;
                }
            }
        }
    }

    #[allow(clippy::too_many_lines, reason = "单步执行为主干直线逻辑")]
    fn step(
        &mut self,
        entry: &mut Entry,
        late: bool,
        now: u64,
        frames: &FrameStatus,
        limits: &Limits,
    ) -> Step {
        let Some(producer) = self.current_producer() else {
            return drain_released(entry, ReleaseReason::ProducerChanged, false);
        };
        if !entry.held_done && !self.ledger.release_missing(&entry.held) {
            return drain_released(entry, ReleaseReason::InjectionBlocked, true);
        }
        if late {
            while let Some(action) = entry.actions.pop_front() {
                entry.done.push(dropped(&action, DropReason::Superseded));
            }
            return Step::Done;
        }
        if !entry.held_done {
            for input in &entry.held {
                if self.ledger.holds(input) {
                    continue;
                }
                if let Err(reason) = self.authority(&producer, now, frames, limits) {
                    return drain_released(entry, reason, false);
                }
                match self.ledger.press(input.clone(), now) {
                    Inject::Done => {}
                    Inject::FocusLost | Inject::FocusChanged => {
                        return drain_released(entry, ReleaseReason::FocusLost, false);
                    }
                    Inject::Blocked => {
                        return drain_released(entry, ReleaseReason::InjectionBlocked, true);
                    }
                }
            }
            entry.held_done = true;
        }
        while !entry.actions.is_empty() {
            if self.ledger.has_transient()
                && let Some(at) = self.ledger.next_lift()
            {
                return Step::Defer(at);
            }
            let action = entry.actions.pop_front().expect("not empty");
            let id = action_id(&action);
            if self
                .current
                .as_ref()
                .is_some_and(|current| current.executed.contains(&id))
            {
                entry.done.push(dropped(&action, DropReason::Duplicate));
                continue;
            }
            if has_coordinates(&action) && frames.geometry_changed_since(entry.base_frame) {
                entry
                    .done
                    .push(dropped(&action, DropReason::GeometryChanged));
                continue;
            }
            self.prune_rate(now);
            if let Some(reason) = self.policy_drop(&action, frames) {
                entry.done.push(dropped(&action, reason));
                continue;
            }
            if let Err(reason) = self.authority(&producer, now, frames, limits) {
                entry.done.push(dropped(&action, DropReason::Released));
                return Step::Release {
                    reason,
                    revoke: false,
                };
            }
            match self.inject(&action, now) {
                Inject::Done => {
                    entry.done.push(ActionOutcome::Executed(Executed {
                        id,
                        at_ns: clock::now_ns(),
                    }));
                    if let Some(current) = self.current.as_mut() {
                        current.executed.insert(id);
                    }
                    self.rate.push_back(now);
                }
                Inject::FocusChanged => {
                    entry.done.push(ActionOutcome::Uncertain(Uncertain {
                        id,
                        at_ns: clock::now_ns(),
                    }));
                    return Step::Release {
                        reason: ReleaseReason::FocusLost,
                        revoke: false,
                    };
                }
                Inject::FocusLost => {
                    entry.done.push(dropped(&action, DropReason::Released));
                    return Step::Release {
                        reason: ReleaseReason::FocusLost,
                        revoke: false,
                    };
                }
                Inject::Blocked => {
                    entry.done.push(dropped(&action, DropReason::Released));
                    return Step::Release {
                        reason: ReleaseReason::InjectionBlocked,
                        revoke: true,
                    };
                }
            }
        }
        Step::Done
    }

    fn policy_drop(&self, action: &Action, frames: &FrameStatus) -> Option<DropReason> {
        let policy = self.policy.as_ref()?;
        if let Some((x, y)) = coordinates(action) {
            let allowed = frames.latest_geometry().is_some_and(|geometry| {
                policy.point_allowed(x, y, geometry.width, geometry.height)
            });
            if !allowed {
                return Some(DropReason::NotAllowed);
            }
        }
        (!policy.within_rate(self.rate.len())).then_some(DropReason::RateLimited)
    }

    fn inject(&mut self, action: &Action, now: u64) -> Inject {
        match &self.policy {
            Some(policy) => {
                let lift_ns = now.saturating_add(nanos(policy.press_duration()));
                match action {
                    Action::Click(click) => self.ledger.begin_momentary(
                        Momentary::Click {
                            x: click.x,
                            y: click.y,
                            button: click.button,
                        },
                        lift_ns,
                    ),
                    Action::KeyPress(press) => self.ledger.begin_momentary(
                        Momentary::Key {
                            scan_code: press.scan_code,
                        },
                        lift_ns,
                    ),
                    Action::Scroll(_) | Action::MouseMove(_) => self.ledger.act(action),
                }
            }
            None => self.ledger.act(action),
        }
    }
}

fn drain_released(entry: &mut Entry, reason: ReleaseReason, revoke: bool) -> Step {
    while let Some(action) = entry.actions.pop_front() {
        entry.done.push(dropped(&action, DropReason::Released));
    }
    Step::Release { reason, revoke }
}
