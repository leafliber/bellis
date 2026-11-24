use std::collections::VecDeque;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::{
    Capture, Command, FRAME_WAIT, FrameSink, FrameStatus, Pipeline, RECOVER_INTERVAL,
    SEARCH_INTERVAL, SourceOpener, TargetError, check_window_rule, opener_for,
};
use crate::capture::{CaptureError, CaptureSource, Frame, FrameMeta, WindowIdentity};
use crate::protocol::{CaptureState, LatestFrame, WindowTargetParams};
use crate::ring::FrameWriteError;

type Log = Arc<Mutex<Vec<String>>>;
type Step = Result<Option<Frame>, CaptureError>;

fn entries(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

fn frame(number: u64, width: u32) -> Frame {
    Frame {
        meta: FrameMeta {
            number,
            captured_at_ns: 1_000 * number,
            transform_version: 1,
            width,
            height: 1,
            stride: width * 4,
            ..FrameMeta::default()
        },
        pixels: vec![0; width as usize * 4],
    }
}

struct ScriptedSource {
    name: &'static str,
    steps: VecDeque<Step>,
    log: Log,
}

impl CaptureSource for ScriptedSource {
    fn window_identity(&self) -> Option<WindowIdentity> {
        Some(WindowIdentity {
            handle: isize::from(self.name.as_bytes()[0]),
            process_id: 123,
        })
    }

    fn next_frame(&mut self, timeout: Duration, out: &mut Frame) -> Result<bool, CaptureError> {
        assert_eq!(timeout, FRAME_WAIT);
        match self.steps.pop_front() {
            None | Some(Ok(None)) => Ok(false),
            Some(Ok(Some(frame))) => {
                *out = frame;
                Ok(true)
            }
            Some(Err(error)) => Err(error),
        }
    }
}

impl Drop for ScriptedSource {
    fn drop(&mut self) {
        self.log.lock().unwrap().push(format!("drop {}", self.name));
    }
}

struct ScriptedOpener {
    name: &'static str,
    opens: VecDeque<Result<Vec<Step>, CaptureError>>,
    log: Log,
}

impl ScriptedOpener {
    fn boxed(
        name: &'static str,
        opens: Vec<Result<Vec<Step>, CaptureError>>,
        log: &Log,
    ) -> Box<dyn SourceOpener> {
        Box::new(Self {
            name,
            opens: opens.into(),
            log: Arc::clone(log),
        })
    }
}

impl SourceOpener for ScriptedOpener {
    fn open(&mut self) -> Result<Box<dyn CaptureSource>, CaptureError> {
        self.log.lock().unwrap().push(format!("open {}", self.name));
        let steps = self.opens.pop_front().unwrap_or_else(|| Err(not_found()))?;
        Ok(Box::new(ScriptedSource {
            name: self.name,
            steps: steps.into(),
            log: Arc::clone(&self.log),
        }))
    }
}

impl fmt::Display for ScriptedOpener {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name)
    }
}

struct RecordingSink {
    next: u64,
    written: Arc<Mutex<Vec<u64>>>,
}

impl RecordingSink {
    const MAX_WIDTH: u32 = 4;

    fn boxed(written: &Arc<Mutex<Vec<u64>>>) -> Box<dyn FrameSink> {
        Box::new(Self {
            next: 100,
            written: Arc::clone(written),
        })
    }
}

impl FrameSink for RecordingSink {
    fn resume_after(&mut self, previous_frame: u64) {
        self.next = self.next.max(previous_frame);
    }

    fn write(&mut self, frame: &Frame) -> Result<u64, FrameWriteError> {
        if frame.meta.width > Self::MAX_WIDTH {
            return Err(FrameWriteError::TooLarge {
                width: frame.meta.width,
                height: frame.meta.height,
                max_width: Self::MAX_WIDTH,
                max_height: 1,
            });
        }
        self.written.lock().unwrap().push(frame.meta.number);
        self.next += 1;
        Ok(self.next)
    }
}

fn not_found() -> CaptureError {
    CaptureError::WindowNotFound {
        selector: "title \"Game\"".into(),
    }
}

#[allow(clippy::unnecessary_wraps)]
fn latest(frame_number: u64, source_number: u64) -> Option<LatestFrame> {
    Some(LatestFrame {
        frame_number,
        capture_ns: 1_000 * source_number,
    })
}

struct Fixture {
    status: Arc<FrameStatus>,
    pipeline: Pipeline,
    log: Log,
    written: Arc<Mutex<Vec<u64>>>,
}

impl Fixture {
    fn new() -> Self {
        let status = Arc::new(FrameStatus::default());
        let invalidate = Arc::clone(&status);
        Self {
            pipeline: Pipeline::new(Arc::clone(&status), move || invalidate.forget()),
            status,
            log: Log::default(),
            written: Arc::default(),
        }
    }

    fn attach(&mut self) {
        assert!(
            self.pipeline
                .apply(Command::Attach(RecordingSink::boxed(&self.written)))
        );
    }

    fn target(&mut self, name: &'static str, opens: Vec<Result<Vec<Step>, CaptureError>>) {
        let opener = ScriptedOpener::boxed(name, opens, &self.log);
        assert!(self.pipeline.apply(Command::Target(opener)));
    }

    fn state(&self) -> CaptureState {
        self.status.snapshot().0
    }

    fn latest(&self) -> Option<LatestFrame> {
        self.status.snapshot().1
    }
}

#[test]
fn idle_until_both_ring_and_target_arrive_then_recovers_and_searches() {
    let mut fx = Fixture::new();
    let t0 = Instant::now();
    assert_eq!(fx.pipeline.step(t0), None);
    assert_eq!(fx.state(), CaptureState::Idle);
    fx.target(
        "a",
        vec![
            Err(not_found()),
            Ok(vec![
                Ok(Some(frame(1, 2))),
                Err(CaptureError::WindowMinimized),
                Ok(Some(frame(2, 3))),
                Err(CaptureError::WindowClosed),
            ]),
            Ok(vec![Ok(Some(frame(1, 2)))]),
        ],
    );
    assert_eq!(fx.pipeline.step(t0), None);
    fx.attach();
    assert_eq!(fx.pipeline.step(t0), Some(SEARCH_INTERVAL));
    assert_eq!(fx.state(), CaptureState::Searching);

    let t1 = t0 + SEARCH_INTERVAL;
    assert_eq!(fx.pipeline.step(t1), Some(Duration::ZERO));
    assert_eq!(fx.latest(), latest(101, 1));
    assert!(!fx.status.geometry_changed_since(101));
    assert_eq!(fx.pipeline.step(t1), Some(RECOVER_INTERVAL));
    assert_eq!(fx.pipeline.step(t1), Some(Duration::ZERO));
    assert_eq!(fx.latest(), latest(102, 2));
    assert!(fx.status.geometry_changed_since(101));

    // 不可恢复错误：清空最近帧与窗口身份，重新搜索。
    assert_eq!(fx.pipeline.step(t1), Some(SEARCH_INTERVAL));
    assert_eq!(fx.state(), CaptureState::Searching);
    assert_eq!(fx.latest(), None);
    assert_eq!(fx.status.captured_window(), None);
    assert_eq!(entries(&fx.log), ["open a", "open a", "drop a"]);
}

#[test]
fn capture_thread_writes_frames_and_stops_promptly() {
    let status = Arc::new(FrameStatus::default());
    let invalidate = Arc::clone(&status);
    let (capture, worker) =
        Capture::spawn(Arc::clone(&status), move || invalidate.forget()).unwrap();
    let log = Log::default();
    let written = Arc::default();
    let steps = (1..=3).map(|n| Ok(Some(frame(n, 2)))).collect();
    assert!(
        capture
            .set_target(ScriptedOpener::boxed("a", vec![Ok(steps)], &log))
            .is_ok()
    );
    assert!(
        capture
            .send(Command::Attach(RecordingSink::boxed(&written)))
            .is_ok()
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while status.snapshot() != (CaptureState::Capturing, latest(103, 3)) {
        assert!(Instant::now() < deadline, "{:?}", status.snapshot());
        thread::sleep(Duration::from_millis(1));
    }
    assert!(worker.stop(Duration::from_secs(5)));
    assert_eq!(entries(&log), ["open a", "drop a"]);
}

#[test]
fn window_targets_require_process_and_class_or_title() {
    let ok = WindowTargetParams {
        process_name: "StarRail.exe".into(),
        window_class: Some("UnityWndClass".into()),
        title: None,
    };
    assert!(check_window_rule(&ok).is_ok());
    let bad = WindowTargetParams {
        process_name: "StarRail.exe".into(),
        window_class: None,
        title: None,
    };
    assert!(matches!(opener_for(bad), Err(TargetError::Invalid(_))));
}
