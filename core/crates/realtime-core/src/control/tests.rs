//! 控制状态单元测试：三方权威、心跳超时、动作块调度/去重/限速/最长按住、统一许可续约/吊销/急停与释放。

use std::sync::Arc;
use std::time::Duration;

use crate::capture::{FrameStatus, Geometry};
use crate::control::{Configured, Control, Limits, Notice, Notices, Rejection, check_block};
use crate::input::ledger::tests::{Recorder, axis, key};
use crate::protocol::{
    Action, ActionBlock, ActionOutcome, ActionSubmitResult, Click, ControlStep, DropReason,
    InputPolicy, KeyPress, LatestFrame, LeaseRenewParams, LeaseStatus, MouseButton, NormRect,
    Producer, ProducerHeartbeatParams, RejectReason, ReleaseReason,
};

const MS: u64 = 1_000_000;
const T0: u64 = 1_000_000 * MS;

fn limits() -> Limits {
    Limits {
        heartbeat_timeout: Duration::from_millis(500),
        max_frame_age: Duration::from_millis(100),
    }
}

fn producer(id: &str, generation: u64) -> Producer {
    Producer {
        id: id.to_owned(),
        generation,
    }
}

fn beat(id: &str, generation: u64, seq: u64) -> ProducerHeartbeatParams {
    ProducerHeartbeatParams {
        producer: producer(id, generation),
        seq,
    }
}

fn fresh_frames(capture_ns: u64) -> Arc<FrameStatus> {
    let frames = Arc::new(FrameStatus::default());
    frames.record(
        LatestFrame {
            frame_number: 1,
            capture_ns,
        },
        Geometry {
            width: 100,
            height: 100,
            dpi: 96,
        },
        None,
    );
    frames
}

fn block(seq: u64, start: u64, valid_ms: u64, steps: Vec<ControlStep>) -> ActionBlock {
    ActionBlock {
        producer: producer("a", 1),
        seq,
        base_frame: 1,
        start_ns: start,
        deadline_ns: start + valid_ms * MS,
        steps,
    }
}

fn receipts(notices: &Notices) -> Vec<(u64, Vec<String>)> {
    notices
        .receipts()
        .into_iter()
        .map(|receipt| {
            let outcomes = receipt
                .outcomes
                .iter()
                .map(|o| match o {
                    ActionOutcome::Executed(e) => format!("executed {}", e.id),
                    ActionOutcome::Dropped(d) => format!("dropped {} {:?}", d.id, d.reason),
                    ActionOutcome::Uncertain(u) => format!("uncertain {}", u.id),
                })
                .collect();
            (receipt.block_seq, outcomes)
        })
        .collect()
}

#[test]
fn three_way_authority_blocks_without_lease_heartbeat_or_fresh_frame() {
    let frames = fresh_frames(T0);
    let recorder = Recorder::default();
    let control = Control::new(limits(), Arc::clone(&frames), recorder.backend(), false);

    // 1. 缺许可：心跳新鲜、帧新鲜 -> 释放 NoLease。
    control.heartbeat(&beat("a", 1, 1), T0).unwrap();
    let blk = block(
        1,
        T0,
        200,
        vec![ControlStep {
            offset_ns: 0,
            held: vec![key(0x11)],
            actions: vec![],
        }],
    );
    assert!(matches!(
        control.submit(blk, T0).0,
        ActionSubmitResult::Accepted(_)
    ));
    assert_eq!(control.tick(T0).released(), [ReleaseReason::NoLease]);
    assert_eq!(recorder.take(), ["release all NoLease"]);

    // 2. 授予许可但帧已过期（超过 100ms）：释放 FrameStale。
    let (res, _) = control.grant_lease(
        &LeaseRenewParams {
            token: 1,
            expires_ns: T0 + 2000 * MS,
        },
        || T0 + 200 * MS,
    );
    assert!(res.is_ok());
    control.heartbeat(&beat("a", 1, 2), T0 + 200 * MS).unwrap();
    let blk2 = block(
        2,
        T0 + 200 * MS,
        200,
        vec![ControlStep {
            offset_ns: 0,
            held: vec![key(0x11)],
            actions: vec![],
        }],
    );
    assert!(matches!(
        control.submit(blk2, T0 + 200 * MS).0,
        ActionSubmitResult::Accepted(_)
    ));
    assert_eq!(
        control.tick(T0 + 200 * MS).released(),
        [ReleaseReason::FrameStale]
    );

    // 3. 帧新鲜 + 心跳新鲜 + 许可有效 -> 成功按下并在心跳超时时自动释放！
    frames.record(
        LatestFrame {
            frame_number: 2,
            capture_ns: T0 + 250 * MS,
        },
        Geometry {
            width: 100,
            height: 100,
            dpi: 96,
        },
        None,
    );
    let blk3 = block(
        3,
        T0 + 250 * MS,
        900,
        vec![ControlStep {
            offset_ns: 0,
            held: vec![key(0x11)],
            actions: vec![],
        }],
    );
    assert!(matches!(
        control.submit(blk3, T0 + 250 * MS).0,
        ActionSubmitResult::Accepted(_)
    ));
    assert!(control.tick(T0 + 250 * MS).is_empty());
    assert_eq!(recorder.take(), ["release all FrameStale", "down key 0x11"]);

    // 500ms 后心跳超时 -> Fail-Closed 释放。
    assert_eq!(
        control.tick(T0 + 700 * MS).released(),
        [ReleaseReason::HeartbeatTimeout]
    );
    assert_eq!(
        recorder.take(),
        ["up key 0x11", "release all HeartbeatTimeout"]
    );
}

#[test]
#[allow(clippy::too_many_lines, reason = "端到端覆盖全部输入策略分支")]
fn policy_enforces_whitelist_regions_rate_momentary_and_max_hold() {
    let frames = fresh_frames(T0);
    let recorder = Recorder::default();
    let control = Control::new(limits(), Arc::clone(&frames), recorder.backend(), true);
    let policy = InputPolicy {
        click_buttons: vec![MouseButton::Left],
        press_keys: vec![0x1C],
        scroll: false,
        click_regions: vec![NormRect {
            left: 0.0,
            top: 0.0,
            right: 0.5,
            bottom: 0.5,
        }],
        forbidden_zones: vec![NormRect {
            left: 0.2,
            top: 0.2,
            right: 0.3,
            bottom: 0.3,
        }],
        press_duration_ms: 40,
        max_rate: 1.0,
        hold_keys: vec![0x11],
        hold_buttons: vec![],
        max_hold_ms: Some(200),
    };
    assert_eq!(control.configure(&policy).unwrap(), Configured::Accepted);
    assert_eq!(control.configure(&policy).unwrap(), Configured::Conflict);
    control
        .grant_lease(
            &LeaseRenewParams {
                token: 1,
                expires_ns: T0 + 2000 * MS,
            },
            || T0,
        )
        .0
        .unwrap();
    control.heartbeat(&beat("a", 1, 1), T0).unwrap();

    // 不在白名单的键被整块拒绝。
    let bad = block(
        1,
        T0,
        300,
        vec![ControlStep {
            offset_ns: 0,
            held: vec![],
            actions: vec![Action::KeyPress(KeyPress {
                id: 1,
                scan_code: 0x99,
            })],
        }],
    );
    assert!(matches!(
        control.submit(bad, T0).0,
        ActionSubmitResult::Rejected(r) if r.reason == RejectReason::NotAllowed
    ));

    // 点击禁区被丢弃，点击允许区按瞬时按住 40ms 后抬起，第二下触发限速，持续按住超 200ms 触发 MaxHold。
    let ok = block(
        2,
        T0,
        400,
        vec![ControlStep {
            offset_ns: 0,
            held: vec![key(0x11)],
            actions: vec![
                Action::Click(Click {
                    id: 10,
                    x: 25,
                    y: 25,
                    button: MouseButton::Left,
                }),
                Action::Click(Click {
                    id: 11,
                    x: 10,
                    y: 10,
                    button: MouseButton::Left,
                }),
                Action::Click(Click {
                    id: 12,
                    x: 10,
                    y: 10,
                    button: MouseButton::Left,
                }),
            ],
        }],
    );
    assert!(matches!(
        control.submit(ok, T0).0,
        ActionSubmitResult::Accepted(_)
    ));
    let _ = control.tick(T0);
    // 40ms 后瞬时抬起，接着第 3 个点击因限速被丢弃。
    let notices = control.tick(T0 + 40 * MS);
    assert_eq!(
        receipts(&notices),
        vec![(
            2,
            vec![
                "dropped 10 NotAllowed".into(),
                "executed 11".into(),
                "dropped 12 RateLimited".into(),
            ]
        )]
    );
    // 200ms 后触发 MaxHold 释放全部持续按住。
    frames.record(
        LatestFrame {
            frame_number: 2,
            capture_ns: T0 + 180 * MS,
        },
        Geometry {
            width: 100,
            height: 100,
            dpi: 96,
        },
        None,
    );
    let max_hold = control.tick(T0 + 200 * MS);
    assert_eq!(max_hold.released(), [ReleaseReason::MaxHold]);
}

#[test]
fn input_stop_and_release_do_not_block_on_capture_lock() {
    let frames = fresh_frames(T0);
    let recorder = Recorder::default();
    let control = Control::new(limits(), Arc::clone(&frames), recorder.backend(), false);
    let now = crate::clock::now_ns();
    control
        .grant_lease(
            &LeaseRenewParams {
                token: 5,
                expires_ns: now + 10_000 * MS,
            },
            || now,
        )
        .0
        .unwrap();

    // 旧水位停止不触碰更新的有效令牌 5。
    let (id, notices) = control.stop_input(Some(4), || now + MS);
    assert_eq!(id, None);
    assert!(notices.is_empty());
    assert_eq!(control.health().lease, LeaseStatus::Valid);

    // 占住采集锁期间，无条件 input.stop 仍能立即释放，绝不死锁。
    let _guard = frames.hold();
    let (id, notices) = control.stop_input(None, || now + 2 * MS);
    assert!(id.is_some());
    assert_eq!(notices.released(), [ReleaseReason::InputStop]);
    assert!(matches!(
        notices.0.first(),
        Some(Notice::Released(r)) if r.token == Some(5)
    ));
}

#[test]
fn check_block_and_heartbeat_rejections() {
    let bad = block(
        1,
        T0,
        100,
        vec![ControlStep {
            offset_ns: 0,
            held: vec![axis("yaw", 2.0)],
            actions: vec![],
        }],
    );
    assert!(check_block(&bad).is_err());

    let control = Control::new(limits(), fresh_frames(T0), None, false);
    assert!(control.heartbeat(&beat("a", 2, 1), T0).is_ok());
    assert_eq!(
        control.heartbeat(&beat("a", 1, 1), T0).unwrap_err(),
        Rejection::StaleGeneration
    );
    assert_eq!(
        control.heartbeat(&beat("b", 2, 1), T0).unwrap_err(),
        Rejection::ProducerMismatch
    );
    assert_eq!(
        control.heartbeat(&beat("a", 2, 1), T0).unwrap_err(),
        Rejection::StaleSeq
    );
    let _ = DropReason::Duplicate;
}
