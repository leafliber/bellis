//! 控制状态机的动作块计划、当前产出者与结果批次数据结构。

use std::collections::{HashSet, VecDeque};
use std::time::Duration;

use super::{Notice, Notices};
use crate::protocol::{
    Action, ActionBlock, ActionOutcome, ActionReceiptParams, DropReason, Dropped, HeldInput,
    Producer,
};

pub(super) struct Current {
    pub(super) producer: Producer,
    pub(super) last_seq: Option<u64>,
    pub(super) deadline: Option<u64>,
    pub(super) last_block_seq: Option<u64>,
    pub(super) executed: HashSet<u64>,
}

impl Current {
    pub(super) fn new(producer: Producer) -> Self {
        Self {
            producer,
            last_seq: None,
            deadline: None,
            last_block_seq: None,
            executed: HashSet::new(),
        }
    }
}

pub(super) struct Entry {
    pub(super) at_ns: u64,
    pub(super) deadline_ns: u64,
    pub(super) block_seq: u64,
    pub(super) base_frame: u64,
    pub(super) held: Vec<HeldInput>,
    pub(super) actions: VecDeque<Action>,
    pub(super) held_done: bool,
    pub(super) done: Vec<ActionOutcome>,
}

#[derive(Clone, Copy)]
pub(super) struct ActiveBlock {
    pub(super) seq: u64,
    pub(super) deadline_ns: u64,
}

#[derive(Default)]
pub(super) struct Plan {
    pub(super) entries: VecDeque<Entry>,
    pub(super) active: Option<ActiveBlock>,
}

#[derive(Default)]
pub(super) struct Outcomes(Vec<(u64, Vec<ActionOutcome>)>);

impl Outcomes {
    pub(super) fn add(&mut self, block_seq: u64, outcome: ActionOutcome) {
        match self.0.last_mut() {
            Some((seq, outcomes)) if *seq == block_seq => outcomes.push(outcome),
            _ => self.0.push((block_seq, vec![outcome])),
        }
    }

    fn drop_all(&mut self, entry: &Entry, reason: DropReason) {
        for outcome in &entry.done {
            self.add(entry.block_seq, outcome.clone());
        }
        for action in &entry.actions {
            self.add(entry.block_seq, dropped(action, reason));
        }
    }

    pub(super) fn emit(self, producer: Option<&Producer>, notices: &mut Notices) {
        let Some(producer) = producer else {
            return;
        };
        for (block_seq, outcomes) in self.0 {
            notices.0.push(Notice::Receipt(ActionReceiptParams {
                producer: producer.clone(),
                block_seq,
                outcomes,
            }));
        }
    }
}

impl Plan {
    pub(super) fn install(&mut self, block: ActionBlock, superseded: &mut Outcomes) {
        let start = block.start_ns;
        let mut kept = VecDeque::with_capacity(self.entries.len() + block.steps.len() + 1);
        for entry in self.entries.drain(..) {
            if entry.at_ns >= start {
                superseded.drop_all(&entry, DropReason::Superseded);
            } else {
                kept.push_back(entry);
            }
        }
        if let Some(old) = self.active
            && old.deadline_ns < start
        {
            kept.push_back(Entry {
                at_ns: old.deadline_ns,
                deadline_ns: old.deadline_ns,
                block_seq: old.seq,
                base_frame: block.base_frame,
                held: Vec::new(),
                actions: VecDeque::new(),
                held_done: false,
                done: Vec::new(),
            });
        }
        for step in block.steps {
            kept.push_back(Entry {
                at_ns: start.saturating_add(step.offset_ns),
                deadline_ns: block.deadline_ns,
                block_seq: block.seq,
                base_frame: block.base_frame,
                held: step.held,
                actions: step.actions.into(),
                held_done: false,
                done: Vec::new(),
            });
        }
        self.entries = kept;
        self.active = Some(ActiveBlock {
            seq: block.seq,
            deadline_ns: block.deadline_ns,
        });
    }

    pub(super) fn clear(&mut self, outcomes: &mut Outcomes) {
        for entry in self.entries.drain(..) {
            outcomes.drop_all(&entry, DropReason::Released);
        }
        self.active = None;
    }
}

pub(super) fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

pub(super) fn action_id(action: &Action) -> u64 {
    match action {
        Action::Click(click) => click.id,
        Action::KeyPress(press) => press.id,
        Action::Scroll(scroll) => scroll.id,
        Action::MouseMove(moved) => moved.id,
    }
}

pub(super) fn has_coordinates(action: &Action) -> bool {
    matches!(action, Action::Click(_) | Action::Scroll(_))
}

pub(super) fn coordinates(action: &Action) -> Option<(u32, u32)> {
    match action {
        Action::Click(click) => Some((click.x, click.y)),
        Action::Scroll(scroll) => Some((scroll.x, scroll.y)),
        Action::KeyPress(_) | Action::MouseMove(_) => None,
    }
}

pub(super) fn dropped(action: &Action, reason: DropReason) -> ActionOutcome {
    ActionOutcome::Dropped(Dropped {
        id: action_id(action),
        reason,
    })
}
