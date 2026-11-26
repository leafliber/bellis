//! 会话层端到端联调测试：真实 Windows 命名管道 + 双向 HMAC 握手 + 核连接与统一许可控制 RPC。

use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use bellis_channel::{
    ChannelCredentials, Frame, FrameDecoder, FrameKind, PROOF_DOMAIN, SessionKey,
    create_channel_path, create_session_key, encode_frame, encode_session_key, mac,
};
use serde_json::{Value, json};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED,
    HANDLE, INVALID_HANDLE_VALUE, WIN32_ERROR,
};
use windows::Win32::Storage::FileSystem::{PIPE_ACCESS_DUPLEX, ReadFile, WriteFile};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows::core::PCWSTR;

use super::config::{ChannelSource, DEFAULT_CORE_ROLE, DEFAULT_PERMIT_ROLE, InputMode, Options};
use super::permit::{PermitConnection, connect_permit};
use super::queue::SendQueue;
use super::{Ended, run};
use crate::capture::FrameStatus;
use crate::clock;
use crate::control::{Control, Limits, Notice, Notices};
use crate::input::win32_hooks::Post;
use crate::input::{Inject, InputBackend, Momentary};
use crate::protocol::{
    Action, HeldInput, PROTOCOL_VERSION, ReleaseReason, core_methods, error_code, permit_methods,
};

struct OwnedPipe(HANDLE);

// SAFETY: 测试服务端对每个管道句柄仅单线程独占读写。
unsafe impl Send for OwnedPipe {}

impl OwnedPipe {
    fn read_some(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut count = 0u32;
        // SAFETY: 同步句柄，`buf` 与 `count` 在调用期间有效。
        match unsafe { ReadFile(self.0, Some(buf), Some(&raw mut count), None) } {
            Ok(()) => Ok(count as usize),
            Err(error)
                if matches!(
                    WIN32_ERROR::from_error(&error),
                    Some(ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED)
                ) =>
            {
                Ok(0)
            }
            Err(error) => Err(io::Error::other(error)),
        }
    }

    fn write_all(&mut self, mut buf: &[u8]) -> io::Result<()> {
        while !buf.is_empty() {
            let mut count = 0u32;
            // SAFETY: 同步句柄，`buf` 与 `count` 在调用期间有效。
            unsafe { WriteFile(self.0, Some(buf), Some(&raw mut count), None) }
                .map_err(io::Error::other)?;
            buf = &buf[count as usize..];
        }
        Ok(())
    }
}

impl Drop for OwnedPipe {
    fn drop(&mut self) {
        // SAFETY: 句柄由本结构独占。
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct TestPipeServer {
    pipe: OwnedPipe,
    decoder: FrameDecoder,
}

impl TestPipeServer {
    fn create(name_tag: &str) -> (String, SessionKey, mpsc::Receiver<Self>) {
        static SEQ: AtomicU64 = AtomicU64::new(1);
        let id = SEQ.fetch_add(1, Ordering::Relaxed);
        let session = format!("r{}t{id}{name_tag}", std::process::id() % 10_000);
        let path = create_channel_path(&session, Path::new(".")).unwrap();
        let key = create_session_key();
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` 是 NUL 结尾的 UTF-16 管道路径。
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                64 * 1024,
                64 * 1024,
                0,
                None,
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE, "CreateNamedPipeW failed");
        let pipe = OwnedPipe(handle);
        let (tx, rx) = mpsc::channel();
        let server_key = key;
        thread::spawn(move || {
            // SAFETY: 单实例管道服务端等待客户端连入；`ERROR_PIPE_CONNECTED` 也表示已连入。
            match unsafe { ConnectNamedPipe(pipe.0, None) } {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        WIN32_ERROR::from_error(&error),
                        Some(ERROR_PIPE_CONNECTED | ERROR_NO_DATA)
                    ) => {}
                Err(_) => return,
            }
            let mut server = Self {
                pipe,
                decoder: FrameDecoder::new(1024 * 1024),
            };
            if server.accept_handshake(&server_key) {
                let _ = tx.send(server);
            }
        });
        (path, key, rx)
    }

    fn accept_handshake(&mut self, key: &SessionKey) -> bool {
        let Some(frame) = self.recv_frame() else {
            return false;
        };
        if frame.kind != FrameKind::Handshake {
            return false;
        }
        let hello: Value = match serde_json::from_slice(&frame.payload) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let role = hello["role"].as_str().unwrap_or("");
        let client_nonce = hello["nonce"].as_str().unwrap_or("");
        let server_nonce = encode_session_key(&create_session_key());
        let server_proof = encode_session_key(&mac(
            key,
            PROOF_DOMAIN,
            "server",
            role,
            client_nonce,
            &server_nonce,
        ));
        self.send_frame(
            FrameKind::Handshake,
            &json!({
                "v": 1,
                "type": "challenge",
                "nonce": server_nonce,
                "proof": server_proof,
            }),
        );
        let Some(frame) = self.recv_frame() else {
            return false;
        };
        if frame.kind != FrameKind::Handshake {
            return false;
        }
        let auth: Value = match serde_json::from_slice(&frame.payload) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let expected_client = encode_session_key(&mac(
            key,
            PROOF_DOMAIN,
            "client",
            role,
            client_nonce,
            &server_nonce,
        ));
        if auth["proof"].as_str() != Some(expected_client.as_str()) {
            return false;
        }
        self.send_frame(FrameKind::Handshake, &json!({ "v": 1, "type": "accept" }));
        true
    }

    fn send_frame(&mut self, kind: FrameKind, value: &Value) {
        let bytes = serde_json::to_vec(value).unwrap();
        let frame = encode_frame(kind, &bytes);
        self.pipe.write_all(&frame).unwrap();
    }

    fn send_json(&mut self, value: &Value) {
        self.send_frame(FrameKind::Json, value);
    }

    fn recv_frame(&mut self) -> Option<Frame> {
        let mut buf = [0u8; 4096];
        loop {
            if let Some(frame) = self.decoder.read().ok().flatten() {
                return Some(frame);
            }
            let n = self.pipe.read_some(&mut buf).ok()?;
            if n == 0 {
                return None;
            }
            self.decoder.push(&buf[..n]);
        }
    }

    fn recv_json(&mut self) -> Option<Value> {
        let frame = self.recv_frame()?;
        (frame.kind == FrameKind::Json)
            .then(|| serde_json::from_slice(&frame.payload).ok())
            .flatten()
    }
}

struct BlockingStdin(mpsc::Receiver<()>);

impl Read for BlockingStdin {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        let _ = self.0.recv();
        Ok(0)
    }
}

struct RecordingBackend {
    releases: Arc<Mutex<Vec<(ReleaseReason, u64)>>>,
}

impl InputBackend for RecordingBackend {
    fn press(&mut self, _input: &HeldInput) -> Inject {
        Inject::Done
    }

    fn release(&mut self, _input: &HeldInput) -> bool {
        true
    }

    fn act(&mut self, _action: &Action) -> Inject {
        Inject::Done
    }

    fn begin_momentary(&mut self, _momentary: &Momentary) -> Inject {
        Inject::Done
    }

    fn end_momentary(&mut self, _momentary: &Momentary) -> bool {
        true
    }

    fn released_all(&mut self, reason: ReleaseReason, release_id: u64) {
        self.releases.lock().unwrap().push((reason, release_id));
    }
}

#[test]
fn core_session_handshake_health_and_graceful_shutdown() {
    let (path, key, server_rx) = TestPipeServer::create("stop");
    let core = ChannelSource::Direct(ChannelCredentials { path, key });
    let options = Options {
        health_interval: Duration::from_millis(50),
        ..Options::default()
    };
    let (stdin_tx, stdin_rx) = mpsc::channel();
    let core_thread = thread::spawn(move || {
        run(
            &options,
            &core,
            DEFAULT_CORE_ROLE,
            InputMode::ReadOnly,
            Some(BlockingStdin(stdin_rx)),
        )
    });

    let mut server = server_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let hello = server.recv_json().unwrap();
    assert_eq!(hello["method"], core_methods::CORE_HELLO);
    assert_eq!(hello["params"]["protocol_version"], PROTOCOL_VERSION);
    server.send_json(&json!({
        "jsonrpc": "2.0",
        "id": hello["id"],
        "result": { "protocol_version": PROTOCOL_VERSION }
    }));

    let start_release = server.recv_json().unwrap();
    assert_eq!(start_release["method"], core_methods::INPUT_RELEASED);
    assert_eq!(start_release["params"]["reason"], "core_start");

    let health = server.recv_json().unwrap();
    assert_eq!(health["method"], core_methods::HEALTH);
    assert_eq!(health["params"]["lease"], "not_granted");

    // 正常 shutdown
    server.send_json(&json!({
        "jsonrpc": "2.0",
        "id": 99,
        "method": core_methods::SHUTDOWN,
        "params": {}
    }));
    let mut saw_shutdown_release = false;
    let mut saw_shutdown_reply = false;
    for _ in 0..10 {
        let msg = server.recv_json().unwrap();
        if msg.get("method").and_then(Value::as_str) == Some(core_methods::INPUT_RELEASED)
            && msg["params"]["reason"] == "shutdown"
        {
            saw_shutdown_release = true;
        } else if msg.get("id") == Some(&json!(99)) {
            assert_eq!(msg["result"], json!({}));
            saw_shutdown_reply = true;
            break;
        }
    }
    assert!(saw_shutdown_release);
    assert!(saw_shutdown_reply);

    drop(stdin_tx);
    let ended = core_thread.join().unwrap().unwrap();
    assert!(matches!(ended, Ended::Stopped));
    drop(server);
}

#[test]
fn core_session_exits_on_stdin_eof() {
    let (path, key, server_rx) = TestPipeServer::create("eof");
    let core = ChannelSource::Direct(ChannelCredentials { path, key });
    let options = Options {
        health_interval: Duration::from_secs(10),
        ..Options::default()
    };
    let (stdin_tx, stdin_rx) = mpsc::channel();
    let core_thread = thread::spawn(move || {
        run(
            &options,
            &core,
            DEFAULT_CORE_ROLE,
            InputMode::ReadOnly,
            Some(BlockingStdin(stdin_rx)),
        )
    });

    let mut server = server_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let hello = server.recv_json().unwrap();
    server.send_json(&json!({
        "jsonrpc": "2.0",
        "id": hello["id"],
        "result": { "protocol_version": PROTOCOL_VERSION }
    }));
    let _start_release = server.recv_json().unwrap();

    // 关闭 stdin 触发生命线退出
    drop(stdin_tx);
    let mut saw_stdin_release = false;
    for _ in 0..8 {
        if let Some(msg) = server.recv_json()
            && msg.get("method").and_then(Value::as_str) == Some(core_methods::INPUT_RELEASED)
            && msg["params"]["reason"] == "stdin_closed"
        {
            saw_stdin_release = true;
            break;
        }
    }
    assert!(saw_stdin_release);
    let ended = core_thread.join().unwrap().unwrap();
    assert!(matches!(ended, Ended::StdinClosed));
    drop(server);
}

#[test]
fn core_session_without_stdin_exits_on_connection_close() {
    let (path, key, server_rx) = TestPipeServer::create("conn");
    let core = ChannelSource::Direct(ChannelCredentials { path, key });
    let options = Options {
        health_interval: Duration::from_secs(10),
        ..Options::default()
    };
    let core_thread = thread::spawn(move || {
        run::<io::Empty>(
            &options,
            &core,
            DEFAULT_CORE_ROLE,
            InputMode::ReadOnly,
            None,
        )
    });

    let mut server = server_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let hello = server.recv_json().unwrap();
    server.send_json(&json!({
        "jsonrpc": "2.0",
        "id": hello["id"],
        "result": { "protocol_version": PROTOCOL_VERSION }
    }));
    let start_release = server.recv_json().unwrap();
    assert_eq!(start_release["params"]["reason"], "core_start");

    drop(server);
    let ended = core_thread.join().unwrap().unwrap();
    assert!(matches!(ended, Ended::ConnectionClosed(_)));
}

#[test]
#[allow(clippy::too_many_lines, reason = "顺序验证完整许可连接生命周期")]
fn unified_permit_connection_handles_renew_revoke_stop_and_disconnect() {
    let (path, key, server_rx) = TestPipeServer::create("permit");
    let creds = ChannelCredentials { path, key };
    let frames = Arc::new(FrameStatus::default());
    let releases = Arc::new(Mutex::new(Vec::new()));
    let backend: Box<dyn InputBackend> = Box::new(RecordingBackend {
        releases: Arc::clone(&releases),
    });
    let control = Arc::new(Control::new(
        Limits {
            heartbeat_timeout: Duration::from_millis(500),
            max_frame_age: Duration::from_millis(500),
        },
        frames,
        Some(backend),
        false,
    ));

    let permit_queue = Arc::new(SendQueue::default());
    let observed_notices = Arc::new(Mutex::new(Vec::<ReleaseReason>::new()));
    let post: Post = {
        let permit_queue = Arc::clone(&permit_queue);
        let observed = Arc::clone(&observed_notices);
        Arc::new(move |notices: Notices| {
            for notice in notices.0 {
                if let Notice::Released(released) = notice {
                    observed.lock().unwrap().push(released.reason);
                    if let Ok(Value::Object(map)) = serde_json::to_value(&released) {
                        permit_queue.push(permit_methods::INPUT_RELEASED, map);
                    }
                }
            }
        })
    };

    let connection = connect_permit(&creds, DEFAULT_PERMIT_ROLE).unwrap();
    let permit =
        PermitConnection::start(connection, Arc::clone(&permit_queue), &control, &post).unwrap();
    let mut server = server_rx.recv_timeout(Duration::from_secs(5)).unwrap();

    // 1. lease.renew 授予令牌 2
    let expires_ns = clock::now_ns() + 10_000_000_000;
    server.send_json(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": permit_methods::LEASE_RENEW,
        "params": { "token": 2, "expires_ns": expires_ns }
    }));
    let reply = server.recv_json().unwrap();
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["result"], json!({}));
    assert!(control.lease_valid());

    // 2. 旧令牌 1 被拒（-32004）
    server.send_json(&json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": permit_methods::LEASE_RENEW,
        "params": { "token": 1, "expires_ns": expires_ns }
    }));
    let err_reply = server.recv_json().unwrap();
    assert_eq!(err_reply["id"], 2);
    assert_eq!(err_reply["error"]["code"], error_code::LEASE_REFUSED);

    // 3. input.stop（无条件）立即释放并返回 release_id，随后收到 input.released
    server.send_json(&json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": permit_methods::INPUT_STOP,
        "params": { "through_token": null }
    }));
    let mut saw_stop_reply = false;
    let mut saw_stop_release = false;
    for _ in 0..6 {
        let msg = server.recv_json().unwrap();
        if msg.get("id") == Some(&json!(3)) {
            assert!(msg["result"]["release_id"].as_u64().is_some());
            saw_stop_reply = true;
        } else if msg.get("method").and_then(Value::as_str) == Some(permit_methods::INPUT_RELEASED)
        {
            assert_eq!(msg["params"]["reason"], "input_stop");
            saw_stop_release = true;
        }
        if saw_stop_reply && saw_stop_release {
            break;
        }
    }
    assert!(saw_stop_reply && saw_stop_release);
    assert!(!control.lease_valid());

    // 4. 授予令牌 3 后 lease.revoke 吊销
    server.send_json(&json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": permit_methods::LEASE_RENEW,
        "params": { "token": 3, "expires_ns": clock::now_ns() + 10_000_000_000 }
    }));
    let reply = server.recv_json().unwrap();
    assert_eq!(reply["id"], 4);
    assert!(control.lease_valid());

    server.send_json(&json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": permit_methods::LEASE_REVOKE,
        "params": { "token": 3 }
    }));
    let mut saw_revoke_reply = false;
    let mut saw_revoke_release = false;
    for _ in 0..6 {
        let msg = server.recv_json().unwrap();
        if msg.get("id") == Some(&json!(5)) {
            assert_eq!(msg["result"], json!({}));
            saw_revoke_reply = true;
        } else if msg.get("method").and_then(Value::as_str) == Some(permit_methods::INPUT_RELEASED)
            && msg["params"]["reason"] == "lease_revoked"
        {
            saw_revoke_release = true;
        }
        if saw_revoke_reply && saw_revoke_release {
            break;
        }
    }
    assert!(saw_revoke_reply && saw_revoke_release);

    // 5. 断开许可连接触发 lease_source_lost
    drop(server);
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if observed_notices
            .lock()
            .unwrap()
            .contains(&ReleaseReason::LeaseSourceLost)
        {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        observed_notices
            .lock()
            .unwrap()
            .contains(&ReleaseReason::LeaseSourceLost)
    );
    permit.finish(Duration::from_millis(100));
}
