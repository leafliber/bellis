//! 真实 Windows 命名管道上的通道集成测试。

mod common;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use bellis_channel::{
    CallError, ConnectionOptions, ErrorCode, FrameKind, Handlers, Message, PROOF_DOMAIN,
    RPC_CANCEL, RpcError, RpcOptions, RpcPeer, connect, create_session_key, encode_session_key,
    mac,
};
use common::{ROLE, ServerStream, serve, unused_path};
use serde_json::{Map, Value, json};

fn options() -> ConnectionOptions {
    ConnectionOptions {
        handshake_timeout: Duration::from_secs(2),
        ..ConnectionOptions::default()
    }
}

fn rpc_options() -> RpcOptions {
    RpcOptions {
        timeout: Duration::from_secs(2),
    }
}

fn params(value: &Value) -> Map<String, Value> {
    value.as_object().expect("对象").clone()
}

fn code_of<T>(result: Result<T, bellis_channel::ChannelError>) -> ErrorCode {
    match result {
        Ok(_) => panic!("期望失败"),
        Err(error) => error.code(),
    }
}

#[test]
fn windows_uses_named_pipes() {
    assert!(unused_path().starts_with(r"\\.\pipe\bellis-"));
}

#[test]
fn authenticated_rpc_in_both_directions() {
    let key = create_session_key();
    let (path, server) = serve(move |mut s: ServerStream| {
        assert_eq!(s.handshake(&key), ROLE);
        let request = s.read_json();
        assert_eq!(request["method"], "math.add");
        let sum =
            request["params"]["a"].as_i64().unwrap() + request["params"]["b"].as_i64().unwrap();
        s.write_json(
            FrameKind::Json,
            &json!({"jsonrpc": "2.0", "id": request["id"], "result": sum}),
        );
        s.write_json(
            FrameKind::Json,
            &json!({"jsonrpc": "2.0", "id": "srv-1", "method": "shutdown", "params": {}}),
        );
        let reply = s.read_json();
        s.write_json(
            FrameKind::Json,
            &json!({"jsonrpc": "2.0", "method": "health", "params": {"seq": 7}}),
        );
        s.write_frame(FrameKind::Binary, &[1, 2, 3]);
        let notification = s.read_json();
        (reply, notification)
    });
    let connection = connect(&path, ROLE, &key, &options()).expect("握手成功");
    assert_eq!(connection.role(), ROLE);
    let (notes, received) = mpsc::channel();
    let handlers = Handlers::new()
        .request("shutdown", |_| Ok(json!({"ok": true})))
        .notification("health", move |params| {
            let _ = notes.send(Value::Object(params.clone()));
        });
    let rpc = RpcPeer::spawn(connection, handlers, &rpc_options()).expect("读线程");
    let sum = rpc
        .request("math.add", Some(&params(&json!({"a": 2, "b": 3}))))
        .expect("应答");
    assert_eq!(sum, json!(5));
    assert_eq!(
        received.recv_timeout(Duration::from_secs(2)).unwrap(),
        json!({"seq": 7})
    );
    rpc.notify("health", Some(&params(&json!({"ok": true}))))
        .expect("通知");
    let (reply, notification) = server.join().unwrap();
    assert_eq!(
        reply,
        json!({"jsonrpc": "2.0", "id": "srv-1", "result": {"ok": true}})
    );
    assert_eq!(
        notification,
        json!({"jsonrpc": "2.0", "method": "health", "params": {"ok": true}})
    );
}

#[test]
fn server_without_the_key_is_rejected() {
    let key = create_session_key();
    let other = create_session_key();
    let (path, server) = serve(move |mut s: ServerStream| {
        s.challenge(&other, |_| {});
        s.frames_until_closed()
    });
    assert_eq!(
        code_of(connect(&path, ROLE, &key, &options())),
        ErrorCode::AuthFailed
    );
    assert_eq!(server.join().unwrap(), 0);
}

#[test]
fn tampered_server_proof_is_rejected() {
    let key = create_session_key();
    let (path, server) = serve(move |mut s: ServerStream| {
        s.challenge(&key, |challenge| {
            let proof = challenge["proof"].as_str().unwrap();
            let flipped = if proof.starts_with('A') { "B" } else { "A" };
            challenge["proof"] = Value::from(format!("{flipped}{}", &proof[1..]));
        });
        s.frames_until_closed()
    });
    assert_eq!(
        code_of(connect(&path, ROLE, &key, &options())),
        ErrorCode::AuthFailed
    );
    assert_eq!(server.join().unwrap(), 0);
}

#[test]
fn replayed_challenge_is_rejected() {
    let key = create_session_key();
    let (path, server) = serve(move |mut s: ServerStream| {
        let hello = s.read_json();
        let client_nonce = hello["nonce"].as_str().unwrap().to_owned();
        let server_nonce = encode_session_key(&create_session_key());
        let proof = mac(
            &key,
            PROOF_DOMAIN,
            "server",
            ROLE,
            &client_nonce,
            &server_nonce,
        );
        let challenge = json!({"v": 1, "type": "challenge", "nonce": server_nonce, "proof": encode_session_key(&proof)});
        s.write_json(FrameKind::Handshake, &challenge);
        let _ = s.read_json();
        s.write_json(FrameKind::Handshake, &json!({"v": 1, "type": "accept"}));
        s.frames_until_closed();
        challenge
    });
    let first = connect(&path, ROLE, &key, &options()).expect("第一次握手成功");
    first.close();
    let challenge = server.join().unwrap();

    let (path, server) = serve(move |mut s: ServerStream| {
        let _ = s.read_json();
        s.write_json(FrameKind::Handshake, &challenge);
        s.frames_until_closed()
    });
    assert_eq!(
        code_of(connect(&path, ROLE, &key, &options())),
        ErrorCode::AuthFailed
    );
    assert_eq!(server.join().unwrap(), 0);
}

#[test]
fn data_and_oversize_before_authentication_are_rejected() {
    let key = create_session_key();
    let (path, server) = serve(|mut s: ServerStream| {
        let _ = s.read_json();
        s.write_json(FrameKind::Json, &json!({"jsonrpc": "2.0", "method": "a.b"}));
        s.frames_until_closed()
    });
    assert_eq!(
        code_of(connect(&path, ROLE, &key, &options())),
        ErrorCode::ProtocolError
    );
    assert_eq!(server.join().unwrap(), 0);

    let (path, server) = serve(|mut s: ServerStream| {
        let _ = s.read_json();
        let mut header = 1025u32.to_be_bytes().to_vec();
        header.push(0);
        s.write_raw(&header);
        s.frames_until_closed()
    });
    assert_eq!(
        code_of(connect(&path, ROLE, &key, &options())),
        ErrorCode::FrameTooLarge
    );
    assert_eq!(server.join().unwrap(), 0);
}

#[test]
fn oversize_frame_after_authentication_is_rejected() {
    let key = create_session_key();
    let (path, server) = serve(move |mut s: ServerStream| {
        s.handshake(&key);
        let at_limit = format!(r#"{{"pad":"{}"}}"#, "x".repeat(64 - 10));
        s.write_frame(FrameKind::Json, at_limit.as_bytes());
        s.write_frame(FrameKind::Json, format!("{at_limit} ").as_bytes());
        s.frames_until_closed()
    });
    let small = ConnectionOptions {
        max_frame_bytes: 64,
        ..options()
    };
    let connection = connect(&path, ROLE, &key, &small).expect("握手成功");
    let too_long = json!({"text": "x".repeat(100)});
    assert_eq!(
        code_of(connection.send(&too_long)),
        ErrorCode::FrameTooLarge
    );
    assert!(connection.is_open());
    match connection
        .recv(Some(Duration::from_secs(2)))
        .expect("等于上限")
    {
        Message::Json(value) => assert_eq!(value["pad"].as_str().unwrap().len(), 54),
        Message::Binary(_) => panic!("意外的二进制帧"),
    }
    assert_eq!(
        code_of(connection.recv(Some(Duration::from_secs(2)))),
        ErrorCode::FrameTooLarge
    );
    assert!(!connection.is_open());
    assert_eq!(server.join().unwrap(), 0);
}

#[test]
fn handshake_timeout_and_read_timeout() {
    let key = create_session_key();
    let (path, server) = serve(|mut s: ServerStream| {
        let _ = s.read_json();
        s.frames_until_closed()
    });
    let quick = ConnectionOptions {
        handshake_timeout: Duration::from_millis(150),
        ..options()
    };
    assert_eq!(
        code_of(connect(&path, ROLE, &key, &quick)),
        ErrorCode::HandshakeTimeout
    );
    assert_eq!(server.join().unwrap(), 0);

    let (go, wait) = mpsc::channel::<()>();
    let (path, server) = serve(move |mut s: ServerStream| {
        s.handshake(&key);
        wait.recv().unwrap();
        let frame = bellis_channel::encode_frame(FrameKind::Json, br#"{"n":1}"#);
        s.write_raw(&frame[..7]);
        wait.recv().unwrap();
        s.write_raw(&frame[7..]);
        s.frames_until_closed()
    });
    let connection = connect(&path, ROLE, &key, &options()).expect("握手成功");
    assert_eq!(
        code_of(connection.recv(Some(Duration::from_millis(80)))),
        ErrorCode::Timeout
    );
    go.send(()).unwrap();
    assert_eq!(
        code_of(connection.recv(Some(Duration::from_millis(80)))),
        ErrorCode::Timeout
    );
    go.send(()).unwrap();
    assert_eq!(
        connection
            .recv(Some(Duration::from_secs(2)))
            .expect("读到完整的帧"),
        Message::Json(json!({"n": 1}))
    );
    connection.close();
    assert_eq!(server.join().unwrap(), 0);
}

#[test]
fn request_timeout_sends_cancel_and_peer_errors_work() {
    let key = create_session_key();
    let (path, server) = serve(move |mut s: ServerStream| {
        s.handshake(&key);
        let request = s.read_json();
        let cancel = s.read_json();
        s.frames_until_closed();
        (request, cancel)
    });
    let connection = connect(&path, ROLE, &key, &options()).expect("握手成功");
    let rpc = RpcPeer::spawn(connection, Handlers::new(), &rpc_options()).expect("读线程");
    match rpc.request_with_timeout("a.hang", None, Duration::from_millis(50)) {
        Err(CallError::Channel(error)) => assert_eq!(error.code(), ErrorCode::Timeout),
        other => panic!("期望超时，得到 {other:?}"),
    }
    rpc.close();
    let (request, cancel) = server.join().unwrap();
    assert_eq!(cancel["method"], RPC_CANCEL);
    assert_eq!(cancel["params"]["id"], request["id"]);
}

#[test]
fn close_wakes_blocked_reader_and_after_reply_runs_after_write() {
    let key = create_session_key();
    let (hooked, hook_fired) = mpsc::channel();
    let (closed, client_closed) = mpsc::channel::<()>();
    let (path, server) = serve(move |mut s: ServerStream| {
        s.handshake(&key);
        s.write_json(
            FrameKind::Json,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "shutdown", "params": {}}),
        );
        s.write_json(
            FrameKind::Json,
            &json!({"jsonrpc": "2.0", "id": 2, "method": "core.refuse"}),
        );
        client_closed.recv().unwrap();
        (s.read_json(), s.read_json(), s.frames_until_closed())
    });
    let connection = connect(&path, ROLE, &key, &options()).expect("握手成功");
    let stop_hooked = hooked.clone();
    let handlers = Handlers::new()
        .request_then(
            "shutdown",
            |_| Ok(json!({})),
            move || stop_hooked.send("stop").unwrap(),
        )
        .request_then(
            "core.refuse",
            |_| Err(RpcError::new(7, "不行")),
            move || hooked.send("refuse").unwrap(),
        );
    let rpc = RpcPeer::spawn(connection, handlers, &rpc_options()).expect("读线程");
    let timeout = Duration::from_secs(2);
    assert_eq!(hook_fired.recv_timeout(timeout), Ok("stop"));
    assert_eq!(hook_fired.recv_timeout(timeout), Ok("refuse"));
    let started = Instant::now();
    rpc.close();
    assert!(started.elapsed() < Duration::from_secs(1));
    closed.send(()).unwrap();
    let (stopped, refused, rest) = server.join().unwrap();
    assert_eq!(stopped, json!({"jsonrpc": "2.0", "id": 1, "result": {}}));
    assert_eq!(
        refused,
        json!({"jsonrpc": "2.0", "id": 2, "error": {"code": 7, "message": "不行"}})
    );
    assert_eq!(rest, 0);
}
