//! 帧环挂接、窗口采集目标与采集线程状态机。
//!
//! 最近写入帧的采集时刻另存一份原子量：权威检查与定时检查读帧龄时不拿采集锁，释放路径绝不等采集线程。

use std::collections::VecDeque;
use std::fmt;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use super::selector::WindowSelector;
use super::wgc::{WgcCapture, WgcOptions, is_supported};
use super::{CaptureError, CaptureSource, Frame, WindowIdentity};
use crate::protocol::{CaptureState, LatestFrame, WindowTargetParams};
use crate::ring::{FrameRingWriter, FrameWriteError};

const SEARCH_INTERVAL: Duration = Duration::from_millis(500);
const FRAME_WAIT: Duration = Duration::from_millis(50);
const RECOVER_INTERVAL: Duration = Duration::from_millis(100);
const GEOMETRY_HISTORY: usize = 16;

/// 帧的客户区几何（尺寸与 DPI）。只移动窗口不改变它。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
}

/// 采集状态、最近写入的一帧与客户区几何历史。
#[derive(Debug)]
pub struct FrameStatus {
    inner: Mutex<StatusInner>,
    has_latest: AtomicBool,
    latest_capture_ns: AtomicU64,
}

#[derive(Debug)]
struct StatusInner {
    state: CaptureState,
    latest: Option<LatestFrame>,
    first_frame: Option<u64>,
    window: Option<WindowIdentity>,
    geometry: VecDeque<(u64, Geometry)>,
}

impl Default for FrameStatus {
    fn default() -> Self {
        Self {
            inner: Mutex::new(StatusInner {
                state: CaptureState::Idle,
                latest: None,
                first_frame: None,
                window: None,
                geometry: VecDeque::new(),
            }),
            has_latest: AtomicBool::new(false),
            latest_capture_ns: AtomicU64::new(0),
        }
    }
}

impl FrameStatus {
    fn lock(&self) -> MutexGuard<'_, StatusInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[must_use]
    pub fn snapshot(&self) -> (CaptureState, Option<LatestFrame>) {
        let inner = self.lock();
        (inner.state, inner.latest)
    }

    /// 本实例最近写入帧的采集时刻（无锁原子读）。
    #[must_use]
    pub fn latest_capture_ns(&self) -> Option<u64> {
        self.has_latest
            .load(Ordering::Acquire)
            .then(|| self.latest_capture_ns.load(Ordering::Acquire))
    }

    #[must_use]
    pub fn latest_geometry(&self) -> Option<Geometry> {
        self.lock().geometry.back().map(|&(_, geometry)| geometry)
    }

    #[must_use]
    pub fn contains_frame(&self, frame_number: u64) -> bool {
        let inner = self.lock();
        inner.first_frame.is_some_and(|first| frame_number >= first)
            && inner
                .latest
                .is_some_and(|latest| frame_number <= latest.frame_number)
    }

    #[must_use]
    pub fn captured_window(&self) -> Option<(WindowIdentity, Geometry)> {
        let inner = self.lock();
        Some((inner.window?, inner.geometry.back()?.1))
    }

    /// 基准帧之后客户区尺寸或 DPI 是否变化；查不到几何时也算变化。
    #[must_use]
    pub fn geometry_changed_since(&self, base_frame: u64) -> bool {
        let inner = self.lock();
        let Some(latest) = inner.latest else {
            return true;
        };
        let Some(&(first, _)) = inner.geometry.front() else {
            return true;
        };
        if base_frame > latest.frame_number || base_frame < first {
            return true;
        }
        let containing = inner
            .geometry
            .iter()
            .rposition(|&(from, _)| from <= base_frame);
        containing != Some(inner.geometry.len() - 1)
    }

    fn set_state(&self, state: CaptureState) -> CaptureState {
        std::mem::replace(&mut self.lock().state, state)
    }

    pub fn forget(&self) {
        let mut inner = self.lock();
        self.has_latest.store(false, Ordering::Release);
        inner.latest = None;
        inner.first_frame = None;
        inner.window = None;
        inner.geometry.clear();
    }

    pub fn record(&self, latest: LatestFrame, geometry: Geometry, window: Option<WindowIdentity>) {
        let mut inner = self.lock();
        inner.first_frame.get_or_insert(latest.frame_number);
        inner.window = window;
        if inner
            .geometry
            .back()
            .is_none_or(|&(_, last)| last != geometry)
        {
            if inner.geometry.len() == GEOMETRY_HISTORY {
                inner.geometry.pop_front();
            }
            inner.geometry.push_back((latest.frame_number, geometry));
        }
        inner.latest = Some(latest);
        self.latest_capture_ns
            .store(latest.capture_ns, Ordering::Release);
        self.has_latest.store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn hold(&self) -> MutexGuard<'_, impl Sized> {
        self.lock()
    }
}

pub(crate) trait SourceOpener: Send + fmt::Display {
    fn open(&mut self) -> Result<Box<dyn CaptureSource>, CaptureError>;
}

pub(crate) trait FrameSink: Send {
    fn resume_after(&mut self, previous_frame: u64);
    fn write(&mut self, frame: &Frame) -> Result<u64, FrameWriteError>;
}

impl FrameSink for FrameRingWriter {
    fn resume_after(&mut self, previous_frame: u64) {
        Self::resume_after(self, previous_frame);
    }

    fn write(&mut self, frame: &Frame) -> Result<u64, FrameWriteError> {
        Self::write(self, frame)
    }
}

#[derive(Debug)]
pub enum TargetError {
    Invalid(&'static str),
    Unsupported(String),
}

impl fmt::Display for TargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => f.write_str(reason),
            Self::Unsupported(reason) => write!(f, "unsupported: {reason}"),
        }
    }
}

/// 核对窗口识别规则（进程名非空，窗口类或标题至少其一）。
pub(crate) fn check_window_rule(target: &WindowTargetParams) -> Result<(), &'static str> {
    if target.process_name.is_empty() {
        return Err("process_name is empty");
    }
    if target.window_class.is_none() && target.title.is_none() {
        return Err("give window_class or title along with process_name");
    }
    Ok(())
}

/// 核对画面采集目标并返回采集线程用的 `SourceOpener`。
pub(crate) fn opener_for(target: WindowTargetParams) -> Result<Box<dyn SourceOpener>, TargetError> {
    check_window_rule(&target).map_err(TargetError::Invalid)?;
    match is_supported() {
        Ok(true) => {}
        Ok(false) => {
            return Err(TargetError::Unsupported(
                "this system does not support Windows Graphics Capture".into(),
            ));
        }
        Err(error) => return Err(TargetError::Unsupported(error.to_string())),
    }
    let selector = WindowSelector {
        process_name: Some(target.process_name),
        class_name: target.window_class,
        title: target.title,
    };
    Ok(Box::new(WindowOpener {
        options: WgcOptions {
            selector,
            ..WgcOptions::default()
        },
    }))
}

struct WindowOpener {
    options: WgcOptions,
}

impl SourceOpener for WindowOpener {
    fn open(&mut self) -> Result<Box<dyn CaptureSource>, CaptureError> {
        Ok(Box::new(WgcCapture::new(&self.options)?))
    }
}

impl fmt::Display for WindowOpener {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "the window matching {}", self.options.selector)
    }
}

enum Command {
    Attach(Box<dyn FrameSink>),
    Target(Box<dyn SourceOpener>),
    Stop,
}

pub struct Capture {
    commands: Sender<Command>,
}

#[derive(Debug)]
pub struct CaptureStopped;

pub struct CaptureThread {
    commands: Sender<Command>,
    exited: Receiver<()>,
}

impl Capture {
    pub(crate) fn spawn(
        status: Arc<FrameStatus>,
        invalidate: impl Fn() + Send + 'static,
    ) -> io::Result<(Self, CaptureThread)> {
        let (commands, receiver) = mpsc::channel();
        let (exited_sender, exited) = mpsc::channel::<()>();
        thread::Builder::new()
            .name("capture".into())
            .spawn(move || {
                let _exited = exited_sender;
                run(&receiver, Pipeline::new(status, invalidate));
                drop(receiver);
            })?;
        Ok((
            Self {
                commands: commands.clone(),
            },
            CaptureThread { commands, exited },
        ))
    }

    pub(crate) fn attach(&self, writer: FrameRingWriter) -> Result<(), CaptureStopped> {
        self.send(Command::Attach(Box::new(writer)))
    }

    pub(crate) fn set_target(&self, opener: Box<dyn SourceOpener>) -> Result<(), CaptureStopped> {
        self.send(Command::Target(opener))
    }

    fn send(&self, command: Command) -> Result<(), CaptureStopped> {
        self.commands.send(command).map_err(|_| CaptureStopped)
    }
}

impl CaptureThread {
    pub(crate) fn stop(self, timeout: Duration) -> bool {
        let _ = self.commands.send(Command::Stop);
        matches!(
            self.exited.recv_timeout(timeout),
            Err(RecvTimeoutError::Disconnected)
        )
    }
}

fn run(commands: &Receiver<Command>, mut pipeline: Pipeline) {
    let mut wait = None;
    loop {
        let first = match wait {
            None => commands.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(timeout) => commands.recv_timeout(timeout),
        };
        let mut next = match first {
            Ok(command) => Some(command),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        while let Some(command) = next {
            if !pipeline.apply(command) {
                return;
            }
            next = commands.try_recv().ok();
        }
        wait = pipeline.step(Instant::now());
    }
}

struct Pipeline {
    status: Arc<FrameStatus>,
    invalidate: Box<dyn Fn() + Send>,
    sink: Option<Box<dyn FrameSink>>,
    opener: Option<Box<dyn SourceOpener>>,
    source: Option<Box<dyn CaptureSource>>,
    frame: Frame,
    last_frame_number: u64,
    retry_at: Option<Instant>,
    problem: Option<String>,
}

impl Pipeline {
    fn new(status: Arc<FrameStatus>, invalidate: impl Fn() + Send + 'static) -> Self {
        Self {
            status,
            invalidate: Box::new(invalidate),
            sink: None,
            opener: None,
            source: None,
            frame: Frame::default(),
            last_frame_number: 0,
            retry_at: None,
            problem: None,
        }
    }

    fn apply(&mut self, command: Command) -> bool {
        match command {
            Command::Attach(mut sink) => {
                if self.sink.is_some() {
                    (self.invalidate)();
                    sink.resume_after(self.last_frame_number);
                }
                self.sink = Some(sink);
            }
            Command::Target(opener) => {
                if self.opener.is_some() {
                    (self.invalidate)();
                }
                self.source = None;
                self.opener = Some(opener);
                self.retry_at = None;
                self.problem = None;
            }
            Command::Stop => {
                self.source = None;
                return false;
            }
        }
        true
    }

    fn step(&mut self, now: Instant) -> Option<Duration> {
        if self.sink.is_none() {
            self.enter(CaptureState::Idle, &"waiting for frame_ring.attach");
            return None;
        }
        let Some(opener) = self.opener.as_mut() else {
            self.enter(CaptureState::Idle, &"waiting for capture.set_target");
            return None;
        };
        if self.source.is_none() {
            if let Some(at) = self.retry_at
                && now < at
            {
                return Some(at - now);
            }
            match opener.open() {
                Ok(source) => {
                    let why = opener.to_string();
                    self.source = Some(source);
                    self.retry_at = None;
                    self.enter(CaptureState::Capturing, &why);
                }
                Err(error) => {
                    self.search(now, &error);
                    return Some(SEARCH_INTERVAL);
                }
            }
        }
        let source = self.source.as_mut()?;
        match source.next_frame(FRAME_WAIT, &mut self.frame) {
            Ok(true) => {
                let window = source.window_identity();
                self.write(window);
                Some(Duration::ZERO)
            }
            Ok(false) => Some(Duration::ZERO),
            Err(error) if error.is_recoverable() => {
                self.report(error.to_string());
                Some(RECOVER_INTERVAL)
            }
            Err(error) => {
                (self.invalidate)();
                self.source = None;
                self.search(now, &error);
                Some(SEARCH_INTERVAL)
            }
        }
    }

    fn search(&mut self, now: Instant, error: &CaptureError) {
        self.retry_at = Some(now + SEARCH_INTERVAL);
        self.enter(CaptureState::Searching, error);
        self.report(error.to_string());
    }

    fn write(&mut self, window: Option<WindowIdentity>) {
        let Some(sink) = self.sink.as_mut() else {
            return;
        };
        match sink.write(&self.frame) {
            Ok(frame_number) => {
                self.last_frame_number = frame_number;
                let meta = &self.frame.meta;
                self.status.record(
                    LatestFrame {
                        frame_number,
                        capture_ns: meta.captured_at_ns,
                    },
                    Geometry {
                        width: meta.width,
                        height: meta.height,
                        dpi: meta.dpi,
                    },
                    window,
                );
                if let Some(problem) = self.problem.take() {
                    log!("capture: frames reach the frame ring again (was: {problem})");
                }
            }
            Err(error) => self.report(format!("frame not written: {error}")),
        }
    }

    fn enter(&self, state: CaptureState, why: &dyn fmt::Display) {
        let previous = self.status.set_state(state);
        if previous != state {
            log!("capture {previous:?} -> {state:?}: {why}");
        }
    }

    fn report(&mut self, problem: String) {
        if self.problem.as_ref() != Some(&problem) {
            log!("capture: {problem}");
            self.problem = Some(problem);
        }
    }
}

#[cfg(test)]
#[path = "pipeline_test.rs"]
mod tests;
