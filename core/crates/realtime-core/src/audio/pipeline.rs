//! 音频环挂接、音频目标与音频主循环线程（独立于控制锁与画面采集锁）。

use std::fmt;
use std::io;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use super::wasapi::ProcessLoopback;
use super::{AudioError, AudioFormat, AudioPacket, AudioSource};
use crate::capture::{CaptureError, WindowSelector, find_window, pipeline::check_window_rule};
use crate::protocol::{CaptureState, LatestAudio, WindowTargetParams};
use crate::ring::{AudioRingWriter, AudioWriteError, BlockMeta};

const SEARCH_INTERVAL: Duration = Duration::from_millis(500);
const PACKET_WAIT: Duration = Duration::from_millis(50);

/// 音频采集状态与最近写进音频环的一块。
#[derive(Debug)]
pub struct AudioStatus {
    inner: Mutex<(CaptureState, Option<LatestAudio>)>,
}

impl Default for AudioStatus {
    fn default() -> Self {
        Self {
            inner: Mutex::new((CaptureState::Idle, None)),
        }
    }
}

impl AudioStatus {
    fn lock(&self) -> MutexGuard<'_, (CaptureState, Option<LatestAudio>)> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[must_use]
    pub fn snapshot(&self) -> (CaptureState, Option<LatestAudio>) {
        *self.lock()
    }

    fn set_state(&self, state: CaptureState) -> CaptureState {
        std::mem::replace(&mut self.lock().0, state)
    }

    fn forget(&self) {
        self.lock().1 = None;
    }

    fn record(&self, latest: LatestAudio) {
        self.lock().1 = Some(latest);
    }
}

#[derive(Debug)]
pub(crate) enum OpenError {
    Window(CaptureError),
    Audio(AudioError),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Window(error) => error.fmt(f),
            Self::Audio(error) => error.fmt(f),
        }
    }
}

pub(crate) trait AudioOpener: Send + fmt::Display {
    fn open(&mut self, format: AudioFormat) -> Result<Box<dyn AudioSource>, OpenError>;
}

pub(crate) trait AudioSink: Send {
    fn format(&self) -> AudioFormat;
    fn write(&mut self, packet: &AudioPacket) -> Result<BlockMeta, AudioWriteError>;
}

impl AudioSink for AudioRingWriter {
    fn format(&self) -> AudioFormat {
        Self::format(self)
    }

    fn write(&mut self, packet: &AudioPacket) -> Result<BlockMeta, AudioWriteError> {
        Self::write(self, packet)
    }
}

#[derive(Debug)]
pub enum AudioTargetError {
    Invalid(&'static str),
}

impl fmt::Display for AudioTargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => f.write_str(reason),
        }
    }
}

pub(crate) fn audio_opener_for(
    target: WindowTargetParams,
) -> Result<Box<dyn AudioOpener>, AudioTargetError> {
    check_window_rule(&target).map_err(AudioTargetError::Invalid)?;
    Ok(Box::new(WindowAudioOpener {
        selector: WindowSelector {
            process_name: Some(target.process_name),
            class_name: target.window_class,
            title: target.title,
        },
    }))
}

struct WindowAudioOpener {
    selector: WindowSelector,
}

impl AudioOpener for WindowAudioOpener {
    fn open(&mut self, format: AudioFormat) -> Result<Box<dyn AudioSource>, OpenError> {
        let window = find_window(&self.selector).map_err(OpenError::Window)?;
        let source = ProcessLoopback::new(window.process_id, format).map_err(OpenError::Audio)?;
        Ok(Box::new(source))
    }
}

impl fmt::Display for WindowAudioOpener {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "the process of the window matching {}", self.selector)
    }
}

enum Command {
    Attach(Box<dyn AudioSink>),
    Target(Box<dyn AudioOpener>),
    Stop,
}

pub struct Audio {
    commands: Sender<Command>,
}

#[derive(Debug)]
pub struct AudioStopped;

pub struct AudioThread {
    commands: Sender<Command>,
    exited: Receiver<()>,
}

impl Audio {
    pub(crate) fn spawn(status: Arc<AudioStatus>) -> io::Result<(Self, AudioThread)> {
        let (commands, receiver) = mpsc::channel();
        let (exited_sender, exited) = mpsc::channel::<()>();
        thread::Builder::new().name("audio".into()).spawn(move || {
            let _exited = exited_sender;
            run(&receiver, status);
            drop(receiver);
        })?;
        Ok((
            Self {
                commands: commands.clone(),
            },
            AudioThread { commands, exited },
        ))
    }

    pub(crate) fn attach(&self, writer: AudioRingWriter) -> Result<(), AudioStopped> {
        self.send(Command::Attach(Box::new(writer)))
    }

    pub(crate) fn set_target(&self, opener: Box<dyn AudioOpener>) -> Result<(), AudioStopped> {
        self.send(Command::Target(opener))
    }

    fn send(&self, command: Command) -> Result<(), AudioStopped> {
        self.commands.send(command).map_err(|_| AudioStopped)
    }
}

impl AudioThread {
    pub(crate) fn stop(self, timeout: Duration) -> bool {
        let _ = self.commands.send(Command::Stop);
        matches!(
            self.exited.recv_timeout(timeout),
            Err(RecvTimeoutError::Disconnected)
        )
    }
}

fn run(commands: &Receiver<Command>, status: Arc<AudioStatus>) {
    let mut pipeline = Pipeline::new(status);
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
    status: Arc<AudioStatus>,
    sink: Option<Box<dyn AudioSink>>,
    opener: Option<Box<dyn AudioOpener>>,
    source: Option<Box<dyn AudioSource>>,
    source_format: Option<AudioFormat>,
    packet: AudioPacket,
    discontinuity: bool,
    retry_at: Option<Instant>,
    problem: Option<String>,
}

impl Pipeline {
    fn new(status: Arc<AudioStatus>) -> Self {
        Self {
            status,
            sink: None,
            opener: None,
            source: None,
            source_format: None,
            packet: AudioPacket::default(),
            discontinuity: true,
            retry_at: None,
            problem: None,
        }
    }

    fn apply(&mut self, command: Command) -> bool {
        match command {
            Command::Attach(sink) => {
                self.status.forget();
                if self.source_format != Some(sink.format()) {
                    self.source = None;
                    self.retry_at = None;
                }
                self.sink = Some(sink);
                self.discontinuity = true;
            }
            Command::Target(opener) => {
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
        let Some(format) = self.sink.as_ref().map(|sink| sink.format()) else {
            self.enter(CaptureState::Idle, &"waiting for audio_ring.attach");
            return None;
        };
        let Some(opener) = self.opener.as_mut() else {
            self.enter(CaptureState::Idle, &"waiting for audio.set_target");
            return None;
        };
        if self.source.is_none() {
            if let Some(at) = self.retry_at
                && now < at
            {
                return Some(at - now);
            }
            match opener.open(format) {
                Ok(source) => {
                    let why = opener.to_string();
                    self.source = Some(source);
                    self.source_format = Some(format);
                    self.retry_at = None;
                    self.discontinuity = true;
                    self.enter(CaptureState::Capturing, &why);
                }
                Err(error) => {
                    self.search(now, &error);
                    return Some(SEARCH_INTERVAL);
                }
            }
        }
        let source = self.source.as_mut()?;
        match source.next_packet(PACKET_WAIT, &mut self.packet) {
            Ok(true) => {
                self.write();
                Some(Duration::ZERO)
            }
            Ok(false) => Some(Duration::ZERO),
            Err(error) => {
                self.source = None;
                self.search(now, &OpenError::Audio(error));
                Some(SEARCH_INTERVAL)
            }
        }
    }

    fn search(&mut self, now: Instant, error: &OpenError) {
        self.retry_at = Some(now + SEARCH_INTERVAL);
        self.enter(CaptureState::Searching, error);
        self.report(error.to_string());
    }

    fn write(&mut self) {
        let Some(sink) = self.sink.as_mut() else {
            return;
        };
        if self.discontinuity {
            self.packet.discontinuity = true;
        }
        match sink.write(&self.packet) {
            Ok(last) => {
                self.discontinuity = false;
                self.status.record(LatestAudio {
                    block_number: last.block_number,
                    capture_ns: last.capture_ns,
                });
                if let Some(problem) = self.problem.take() {
                    log!("audio: blocks reach the audio ring again (was: {problem})");
                }
            }
            Err(error) => {
                self.discontinuity = true;
                self.report(format!("audio packet not written: {error}"));
            }
        }
    }

    fn enter(&self, state: CaptureState, why: &dyn fmt::Display) {
        let previous = self.status.set_state(state);
        if previous != state {
            log!("audio {previous:?} -> {state:?}: {why}");
        }
    }

    fn report(&mut self, problem: String) {
        if self.problem.as_ref() != Some(&problem) {
            log!("audio: {problem}");
            self.problem = Some(problem);
        }
    }
}

#[cfg(test)]
#[path = "pipeline_test.rs"]
mod tests;
