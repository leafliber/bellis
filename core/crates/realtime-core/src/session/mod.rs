//! 实时核会话装配：核连接、统一许可控制连接、媒体线程、调度/健康线程与生命线。

pub mod config;
pub(crate) mod cred;
mod handlers;
mod outbox;
pub(crate) mod permit;
pub(crate) mod queue;

use std::fmt;
use std::io::{self, Read};
use std::sync::Arc;
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use bellis_channel::{
    ChannelError, Connection, ConnectionOptions, Message, RpcKind, RpcOptions, RpcPeer, classify,
    connect,
};
use serde_json::{Value, json};

use config::{HELLO_TIMEOUT, InputMode, Launch, Options};
use handlers::build_handlers;
use outbox::{Outbox, log_released};
use permit::{PermitConnection, connect_permit, resolve_credentials};
use queue::SendQueue;

use crate::audio::{Audio, AudioStatus, AudioThread};
use crate::capture::{Capture, CaptureThread, FrameStatus};
use crate::control::{Control, Limits};
use crate::input::TargetWindow;
use crate::input::win32_hooks::{self, Post};
use crate::protocol::{
    CoreHelloParams, CoreHelloResult, HealthParams, PROTOCOL_VERSION, ReleaseReason, core_methods,
};

/// 实时核版本，经 `core.hello` 报给主控。
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

const RPC_TIMEOUT: Duration = Duration::from_secs(2);
const CAPTURE_STOP_WAIT: Duration = Duration::from_millis(500);
const AUDIO_STOP_WAIT: Duration = Duration::from_millis(500);
const OUTBOX_FLUSH_WAIT: Duration = Duration::from_millis(200);
const PERMIT_FLUSH_WAIT: Duration = Duration::from_millis(200);

/// 会话结束原因（每种均已完成输入释放请求）。
#[derive(Debug)]
pub enum Ended {
    /// 收到 `shutdown` 请求并已回复。
    Stopped,
    /// 核连接关闭或异常断开。
    ConnectionClosed(Option<ChannelError>),
    /// stdin 读到 EOF 或读取失败。
    StdinClosed,
}

impl fmt::Display for Ended {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stopped => f.write_str("shutdown"),
            Self::ConnectionClosed(None) => f.write_str("core connection closed"),
            Self::ConnectionClosed(Some(error)) => write!(f, "core connection lost: {error}"),
            Self::StdinClosed => f.write_str("stdin closed"),
        }
    }
}

/// 启动失败或退出时物理释放核验未通过。
#[derive(Debug)]
pub enum StartError {
    Connect(ChannelError),
    PermitCred(io::Error),
    PermitConnect(ChannelError),
    Hello(String),
    Thread(io::Error),
    UnverifiedRelease,
}

impl fmt::Display for StartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect(error) => write!(f, "cannot connect to the main process: {error}"),
            Self::PermitCred(error) => write!(f, "cannot load permit credentials: {error}"),
            Self::PermitConnect(error) => write!(f, "cannot connect to the permit source: {error}"),
            Self::Hello(reason) => write!(f, "core.hello failed: {reason}"),
            Self::Thread(error) => write!(f, "cannot start a thread: {error}"),
            Self::UnverifiedRelease => f.write_str("physical input release could not be verified"),
        }
    }
}

impl std::error::Error for StartError {}

/// 运行一次实时核会话，直到 `shutdown`、核连接断开或 `stdin` EOF。
///
/// # Errors
///
/// 凭据加载、通道连接、握手、线程启动失败或退出时物理释放未通过核验时返回 [`StartError`]。
pub fn run(
    options: &Options,
    launch: &Launch,
    input: InputMode,
    stdin: impl Read + Send + 'static,
) -> Result<Ended, StartError> {
    let frames = Arc::new(FrameStatus::default());
    let ((control, outbox, permit), connection) = open_session(options, launch, input, &frames)?;

    let invalidate_capture = {
        let (control, outbox) = (Arc::clone(&control), Arc::clone(&outbox));
        move || outbox.post(control.capture_reset())
    };
    let (media, media_threads) = match Media::spawn(frames, invalidate_capture) {
        Ok(spawned) => spawned,
        Err(error) => {
            finish_permit(permit);
            return Err(StartError::Thread(error));
        }
    };
    let (ended, end) = mpsc::channel();
    let peer = match RpcPeer::spawn(
        connection,
        build_handlers(&control, &outbox, &media, ended.clone()),
        &RpcOptions {
            timeout: RPC_TIMEOUT,
        },
    ) {
        Ok(peer) => Arc::new(peer),
        Err(error) => {
            media_threads.stop();
            finish_permit(permit);
            return Err(StartError::Thread(error));
        }
    };
    outbox.attach(&peer);
    log!(
        "connected as {}; heartbeat timeout {}ms, health every {}ms, max frame age {}ms",
        launch.role,
        options.heartbeat_timeout.as_millis(),
        options.health_interval.as_millis(),
        options.max_frame_age.as_millis()
    );

    let workers = start_workers(&control, &media, &outbox, &peer, options, &ended, stdin);
    drop(ended);
    let workers = match workers {
        Ok(workers) => workers,
        Err(error) => {
            outbox.log_and_mirror(&control.release_on_exit(ReleaseReason::CoreConnectionLost));
            outbox.close(OUTBOX_FLUSH_WAIT);
            finish_permit(permit);
            media_threads.stop();
            peer.close();
            return Err(StartError::Thread(error));
        }
    };

    let reason = end.recv().unwrap_or(Ended::ConnectionClosed(None));
    match reason {
        Ended::Stopped => {}
        Ended::ConnectionClosed(_) => {
            outbox.log_and_mirror(&control.release_on_exit(ReleaseReason::CoreConnectionLost));
        }
        Ended::StdinClosed => outbox.post(control.release_on_exit(ReleaseReason::StdinClosed)),
    }
    log!("{reason}; input release requested, exiting");
    for worker in workers {
        let _ = worker.join();
    }
    let release_ok = control.wait_for_final_verification(OUTBOX_FLUSH_WAIT);
    outbox.close(OUTBOX_FLUSH_WAIT);
    finish_permit(permit);
    media_threads.stop();
    peer.close();
    release_ok
        .then_some(reason)
        .ok_or(StartError::UnverifiedRelease)
}

fn finish_permit(permit: Option<PermitConnection>) {
    if let Some(permit) = permit {
        permit.finish(PERMIT_FLUSH_WAIT);
    }
}

type Started = (Arc<Control>, Arc<Outbox>, Option<PermitConnection>);

fn open_session(
    options: &Options,
    launch: &Launch,
    input: InputMode,
    frames: &Arc<FrameStatus>,
) -> Result<(Started, Connection), StartError> {
    let limits = Limits {
        heartbeat_timeout: options.heartbeat_timeout,
        max_frame_age: options.max_frame_age,
    };
    let (control, outbox, permit) = start_input(input, limits, frames)?;
    let startup_release = control.release_on_start();
    log_released(&startup_release);
    outbox.mirror_released(&startup_release);

    let opened = (|| {
        let credentials = &launch.credentials;
        let connection = connect(
            &credentials.path,
            &launch.role,
            &credentials.key,
            &ConnectionOptions::default(),
        )
        .map_err(StartError::Connect)?;
        hello(&connection)?;
        connection
            .send(&json!({
                "jsonrpc": "2.0",
                "method": core_methods::INPUT_RELEASED,
                "params": startup_release,
            }))
            .map_err(StartError::Connect)?;
        Ok(connection)
    })();
    match opened {
        Ok(connection) => Ok(((control, outbox, permit), connection)),
        Err(error) => {
            finish_permit(permit);
            Err(error)
        }
    }
}

fn start_input(
    input: InputMode,
    limits: Limits,
    frames: &Arc<FrameStatus>,
) -> Result<Started, StartError> {
    match input {
        InputMode::ReadOnly => {
            let outbox = Arc::new(Outbox::new(None));
            let control = Arc::new(Control::new(limits, Arc::clone(frames), None, false));
            Ok((control, outbox, None))
        }
        InputMode::Real {
            source,
            role,
            emergency,
        } => {
            let permit_credentials =
                resolve_credentials(&source).map_err(StartError::PermitCred)?;
            let permit_queue = Arc::new(SendQueue::default());
            let outbox = Arc::new(Outbox::new(Some(Arc::clone(&permit_queue))));
            let target = Arc::new(TargetWindow::new(Arc::clone(frames)));
            let (backend, wiring) =
                win32_hooks::build_backend(emergency, target).map_err(StartError::Thread)?;
            let control = Arc::new(Control::new(
                limits,
                Arc::clone(frames),
                Some(backend),
                true,
            ));
            let post: Post = {
                let outbox = Arc::clone(&outbox);
                Arc::new(move |notices| outbox.post(notices))
            };
            let connection =
                connect_permit(&permit_credentials, &role).map_err(StartError::PermitConnect)?;
            let permit = PermitConnection::start(connection, permit_queue, &control, &post)
                .map_err(StartError::Thread)?;
            win32_hooks::start(&control, &post, wiring).map_err(StartError::Thread)?;
            log!("input backend: sendinput (real input with unified permit control)");
            Ok((control, outbox, Some(permit)))
        }
    }
}

pub(crate) struct Media {
    pub(crate) capture: Capture,
    pub(crate) audio: Audio,
    pub(crate) audio_status: Arc<AudioStatus>,
}

struct MediaThreads {
    capture: CaptureThread,
    audio: AudioThread,
}

impl Media {
    fn spawn(
        frames: Arc<FrameStatus>,
        invalidate_capture: impl Fn() + Send + 'static,
    ) -> io::Result<(Arc<Self>, MediaThreads)> {
        let audio_status = Arc::new(AudioStatus::default());
        let (capture, capture_thread) = Capture::spawn(frames, invalidate_capture)?;
        let (audio, audio_thread) = match Audio::spawn(Arc::clone(&audio_status)) {
            Ok(spawned) => spawned,
            Err(error) => {
                stop_thread("capture", capture_thread.stop(CAPTURE_STOP_WAIT));
                return Err(error);
            }
        };
        Ok((
            Arc::new(Self {
                capture,
                audio,
                audio_status,
            }),
            MediaThreads {
                capture: capture_thread,
                audio: audio_thread,
            },
        ))
    }
}

impl MediaThreads {
    fn stop(self) {
        stop_thread("capture", self.capture.stop(CAPTURE_STOP_WAIT));
        stop_thread("audio", self.audio.stop(AUDIO_STOP_WAIT));
    }
}

fn stop_thread(name: &str, stopped: bool) {
    if !stopped {
        log!("the {name} thread did not stop in time");
    }
}

fn hello(connection: &Connection) -> Result<(), StartError> {
    const HELLO_ID: i64 = 0;
    let params = CoreHelloParams {
        protocol_version: PROTOCOL_VERSION,
        core_version: CORE_VERSION.to_owned(),
    };
    connection
        .send(&json!({
            "jsonrpc": "2.0",
            "id": HELLO_ID,
            "method": core_methods::CORE_HELLO,
            "params": params,
        }))
        .map_err(StartError::Connect)?;
    let message = match connection.recv(Some(HELLO_TIMEOUT)) {
        Ok(Message::Json(message)) => message,
        Ok(Message::Binary(_)) => {
            return Err(StartError::Hello(
                "received binary data before the reply".into(),
            ));
        }
        Err(error) => return Err(StartError::Connect(error)),
    };
    if message.get("id") != Some(&Value::from(HELLO_ID)) {
        return Err(StartError::Hello(format!("unexpected message {message}")));
    }
    match classify(&message) {
        RpcKind::Success => {
            let result: CoreHelloResult = serde_json::from_value(message["result"].clone())
                .map_err(|error| StartError::Hello(format!("invalid result: {error}")))?;
            if result.protocol_version == PROTOCOL_VERSION {
                Ok(())
            } else {
                Err(StartError::Hello(format!(
                    "main process speaks protocol {}, core speaks {PROTOCOL_VERSION}",
                    result.protocol_version
                )))
            }
        }
        RpcKind::Failure => Err(StartError::Hello(format!(
            "rejected by the main process: {}",
            message["error"]
        ))),
        _ => Err(StartError::Hello(format!("invalid reply {message}"))),
    }
}

fn collect_health(control: &Control, audio: &AudioStatus) -> HealthParams {
    let mut health = control.health();
    (health.audio, health.latest_audio) = audio.snapshot();
    health
}

fn start_workers(
    control: &Arc<Control>,
    media: &Arc<Media>,
    outbox: &Arc<Outbox>,
    peer: &Arc<RpcPeer>,
    options: &Options,
    ended: &Sender<Ended>,
    stdin: impl Read + Send + 'static,
) -> io::Result<Vec<JoinHandle<()>>> {
    thread::Builder::new().name("core-sender".into()).spawn({
        let outbox = Arc::clone(outbox);
        move || outbox.run_sender()
    })?;
    let scheduler = thread::Builder::new()
        .name("action-scheduler".into())
        .spawn({
            let (control, outbox) = (Arc::clone(control), Arc::clone(outbox));
            move || control.run_scheduler(|notices| outbox.post(notices))
        })?;
    let health = thread::Builder::new().name("core-health".into()).spawn({
        let (control, media, outbox) = (Arc::clone(control), Arc::clone(media), Arc::clone(outbox));
        let interval = options.health_interval;
        move || loop {
            outbox.notify_health(&collect_health(&control, &media.audio_status));
            if control.wait_stopping(interval) {
                return;
            }
        }
    })?;
    thread::Builder::new()
        .name("connection-lifeline".into())
        .spawn({
            let (peer, ended) = (Arc::clone(peer), ended.clone());
            move || {
                let reason = peer.wait_closed(None).flatten();
                let _ = ended.send(Ended::ConnectionClosed(reason));
            }
        })?;
    thread::Builder::new()
        .name("stdin-lifeline".into())
        .spawn({
            let ended = ended.clone();
            move || {
                read_to_eof(stdin);
                let _ = ended.send(Ended::StdinClosed);
            }
        })?;
    Ok(vec![scheduler, health])
}

fn read_to_eof(mut input: impl Read) {
    let mut buffer = [0u8; 256];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests;
