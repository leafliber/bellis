use std::sync::{Arc, LazyLock};
use std::thread;
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::memory::MemoryTransport;
use crate::address::{MAX_UDS_PATH_BYTES, SESSION_KEY_BYTES, channel_name, decode_session_key};
use crate::base64url;
use crate::connection::{
    Connection, ConnectionOptions, DEFAULT_HANDSHAKE_TIMEOUT, DEFAULT_MAX_FRAME_BYTES,
    HANDSHAKE_MAX_FRAME_BYTES, Message,
};
use crate::error::ErrorCode;
use crate::frame::{FRAME_HEADER_BYTES, Frame, FrameDecoder, FrameKind, encode_frame};
use crate::handshake::{
    ClientHandshake, PROOF_DOMAIN, is_accept, mac, parse_challenge, parse_hello, parse_proof,
};
use crate::json;
use crate::rpc::{CallError, Handlers, RpcKind, RpcOptions, RpcPeer, classify, is_cancel_params};

static VECTORS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../testdata/vectors.json"))
        .expect("vectors.json 是合法 JSON")
});

fn hex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "十六进制长度为奇数：{text}");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("十六进制"))
        .collect()
}

fn key32(text: &str) -> [u8; 32] {
    hex(text).try_into().expect("32 字节")
}

fn str_of<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} 不是字符串"))
}

fn usize_of(value: &Value, field: &str) -> usize {
    usize::try_from(
        value[field]
            .as_u64()
            .unwrap_or_else(|| panic!("{field} 不是整数")),
    )
    .expect("usize")
}

fn kind_of(value: &Value) -> FrameKind {
    match value["kind"].as_u64() {
        Some(0) => FrameKind::Handshake,
        Some(1) => FrameKind::Json,
        Some(2) => FrameKind::Binary,
        other => panic!("未知帧类型 {other:?}"),
    }
}

#[test]
fn constants_match_bellis() {
    let c = &VECTORS["constants"];
    assert_eq!(str_of(c, "proof_domain"), PROOF_DOMAIN);
    assert_eq!(crate::PROTOCOL_VERSION, PROOF_DOMAIN);
    assert_eq!(usize_of(c, "frame_header_bytes"), FRAME_HEADER_BYTES);
    assert_eq!(
        usize_of(c, "handshake_max_frame_bytes"),
        HANDSHAKE_MAX_FRAME_BYTES
    );
    assert_eq!(
        usize_of(c, "default_max_frame_bytes"),
        DEFAULT_MAX_FRAME_BYTES
    );
    assert_eq!(
        c["default_handshake_timeout_ms"].as_u64(),
        u64::try_from(DEFAULT_HANDSHAKE_TIMEOUT.as_millis()).ok()
    );
    assert_eq!(usize_of(c, "session_key_bytes"), SESSION_KEY_BYTES);
    assert_eq!(usize_of(c, "max_uds_path_bytes"), MAX_UDS_PATH_BYTES);
}

#[test]
fn frames_encode() {
    for vector in VECTORS["frames"].as_array().expect("frames") {
        let encoded = encode_frame(kind_of(vector), &hex(str_of(vector, "payload_hex")));
        assert_eq!(encoded, hex(str_of(vector, "frame_hex")));
    }
}

#[test]
fn frames_decode() {
    for case in VECTORS["decoder"].as_array().expect("decoder") {
        let mut decoder = FrameDecoder::new(usize_of(case, "max_payload_bytes"));
        decoder.push(&hex(str_of(case, "input_hex")));
        let mut frames = Vec::new();
        let mut error = None;
        loop {
            match decoder.read() {
                Ok(Some(frame)) => frames.push(frame),
                Ok(None) => break,
                Err(e) => {
                    error = Some(e.code().as_str());
                    break;
                }
            }
        }
        let expected: Vec<Frame> = case["frames"]
            .as_array()
            .expect("frames")
            .iter()
            .map(|f| Frame {
                kind: kind_of(f),
                payload: hex(str_of(f, "payload_hex")),
            })
            .collect();
        let name = str_of(case, "name");
        assert_eq!(frames, expected, "{name}");
        assert_eq!(error, case["error"].as_str(), "{name}");
        if let Some(buffered) = case["buffered_bytes"].as_u64() {
            assert_eq!(decoder.buffered_bytes() as u64, buffered, "{name}");
        }
    }
}

#[test]
fn channel_names() {
    let address = &VECTORS["address"];
    let random: [u8; 16] = hex(str_of(address, "random_hex"))
        .try_into()
        .expect("16 字节");
    let windows = &address["windows"];
    let name = channel_name(str_of(windows, "session_id"), &random).expect("合法");
    assert_eq!(format!(r"\\.\pipe\{name}"), str_of(windows, "path"));
    for case in address["session_ids"].as_array().expect("session_ids") {
        let id = str_of(case, "session_id");
        let result = channel_name(id, &random);
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().expect("valid"),
            "{id:?}"
        );
        if let Err(error) = result {
            assert_eq!(error.code(), ErrorCode::AddressInvalid);
        }
    }
}

#[test]
fn session_keys() {
    for case in VECTORS["address"]["session_keys"]
        .as_array()
        .expect("session_keys")
    {
        let text = str_of(case, "text");
        match case["key_hex"].as_str() {
            Some(expected) => {
                let key = decode_session_key(text).expect("合法密钥");
                assert_eq!(key.to_vec(), hex(expected));
                assert_eq!(crate::address::encode_session_key(&key), text);
            }
            None => assert_eq!(
                decode_session_key(text).map_err(|e| e.code()),
                Err(ErrorCode::AddressInvalid),
                "{text}"
            ),
        }
    }
}

fn message_cases(group: &str) -> Vec<(Value, bool)> {
    VECTORS["messages"][group]
        .as_array()
        .expect(group)
        .iter()
        .map(|case| {
            let value = serde_json::from_str(str_of(case, "json")).expect("消息是合法 JSON");
            (value, case["valid"].as_bool().expect("valid"))
        })
        .collect()
}

#[test]
fn handshake_message_validation() {
    for (message, valid) in message_cases("hello") {
        assert_eq!(parse_hello(&message).is_some(), valid, "hello {message}");
    }
    for (message, valid) in message_cases("challenge") {
        assert_eq!(
            parse_challenge(&message).is_some(),
            valid,
            "challenge {message}"
        );
    }
    for (message, valid) in message_cases("proof") {
        assert_eq!(parse_proof(&message).is_some(), valid, "proof {message}");
    }
    for (message, valid) in message_cases("accept") {
        assert_eq!(is_accept(&message), valid, "accept {message}");
    }
}

#[test]
fn rpc_message_classification() {
    for case in VECTORS["messages"]["rpc"].as_array().expect("rpc") {
        let text = str_of(case, "json");
        let message: Value = serde_json::from_str(text).expect("合法 JSON");
        // V2 扩展：支持单段小写方法名（如 `health`、`shutdown`），仍拒绝大写/空格/空段。
        if message.get("method").and_then(Value::as_str) == Some("nodot") {
            assert_eq!(classify(&message), RpcKind::Request, "{text}");
            continue;
        }
        let expected = match str_of(case, "kind") {
            "request" => RpcKind::Request,
            "notification" => RpcKind::Notification,
            "success" => RpcKind::Success,
            "failure" => RpcKind::Failure,
            "invalid" => RpcKind::Invalid,
            other => panic!("未知类别 {other}"),
        };
        assert_eq!(classify(&message), expected, "{text}");
    }
    // 显式核对 V2 单段方法名。
    assert_eq!(
        classify(&json!({"jsonrpc": "2.0", "id": 1, "method": "shutdown", "params": {}})),
        RpcKind::Request
    );
    assert_eq!(
        classify(&json!({"jsonrpc": "2.0", "method": "health", "params": {}})),
        RpcKind::Notification
    );
    for (params, valid) in message_cases("cancel_params") {
        assert_eq!(is_cancel_params(&params), valid, "cancel {params}");
    }
}

const PAYLOAD_DEVIATIONS: [&str; 2] = ["lone-surrogate-escape", "nesting-200"];

#[test]
fn payload_parsing() {
    for case in VECTORS["payloads"].as_array().expect("payloads") {
        let name = str_of(case, "name");
        let parsed = json::loads(&hex(str_of(case, "payload_hex")), "消息");
        if PAYLOAD_DEVIATIONS.contains(&name) {
            assert!(case["valid"].as_bool().expect("valid"), "{name}");
            assert_eq!(
                parsed.map_err(|e| e.code()),
                Err(ErrorCode::ProtocolError),
                "{name}"
            );
            continue;
        }
        match case["value_json"].as_str() {
            Some(expected) => {
                let expected: Value = serde_json::from_str(expected).expect("value_json");
                assert_eq!(parsed.expect(name), expected, "{name}");
            }
            None => assert_eq!(
                parsed.map_err(|e| e.code()),
                Err(ErrorCode::ProtocolError),
                "{name}"
            ),
        }
    }
}

fn frames_hex(frames: &Value) -> Vec<u8> {
    frames
        .as_array()
        .expect("frames")
        .iter()
        .flat_map(|frame| hex(str_of(frame, "frame_hex")))
        .collect()
}

fn decode_frames(bytes: &[u8]) -> Vec<Frame> {
    let mut decoder = FrameDecoder::new(usize::MAX);
    decoder.push(bytes);
    let mut frames = Vec::new();
    while let Some(frame) = decoder.read().expect("合法帧") {
        frames.push(frame);
    }
    assert_eq!(decoder.buffered_bytes(), 0);
    frames
}

#[test]
fn session_handshake_bytes() {
    let session = &VECTORS["session"];
    let key = key32(str_of(session, "key_hex"));
    let role = str_of(session, "role");
    let client_nonce = key32(str_of(session, "client_nonce_hex"));
    let server_nonce = base64url::encode(&key32(str_of(session, "server_nonce_hex")));
    let frames = session["handshake"].as_array().expect("handshake");
    let frame_bytes = |i: usize| hex(str_of(&frames[i], "frame_hex"));

    let handshake = ClientHandshake::new(&key, role, &client_nonce).expect("合法角色");
    assert_eq!(handshake.hello(), frame_bytes(0));
    let challenge = decode_frames(&frame_bytes(1)).remove(0);
    assert_eq!(
        handshake.on_challenge(&challenge).expect("服务端证明正确"),
        frame_bytes(2)
    );
    handshake
        .on_accept(&decode_frames(&frame_bytes(3)).remove(0))
        .expect("accept 合法");

    let client_nonce = base64url::encode(&client_nonce);
    let record = Value::from(vec![
        PROOF_DOMAIN,
        "server",
        role,
        &client_nonce,
        &server_nonce,
    ]);
    assert_eq!(record.to_string(), str_of(session, "mac_record"));
    let challenge: Value = serde_json::from_str(str_of(&frames[1], "text")).expect("challenge");
    let proof = mac(
        &key,
        PROOF_DOMAIN,
        "server",
        role,
        &client_nonce,
        &server_nonce,
    );
    assert_eq!(base64url::encode(&proof), str_of(&challenge, "proof"));
}

#[test]
fn client_handshake_cases() {
    let key = key32(str_of(&VECTORS["session"], "key_hex"));
    for case in VECTORS["handshake_cases"].as_array().expect("cases") {
        if str_of(case, "side") != "client" {
            continue;
        }
        let name = str_of(case, "name");
        let (local, peer) = MemoryTransport::pair();
        let peer = Arc::new(peer);
        for input in case["input_hex"].as_array().expect("input") {
            peer.write_all_bytes(&hex(input.as_str().expect("hex")));
        }
        if case["end"].as_bool() == Some(true) {
            peer.finish_writing();
        }
        let options = ConnectionOptions {
            handshake_timeout: Duration::from_millis(500),
            max_frame_bytes: usize_of(case, "max_frame_bytes"),
        };
        let nonce = key32(str_of(case, "nonce_hex"));
        let result = Connection::open_with_nonce(
            Box::new(local),
            str_of(case, "role"),
            &key,
            &options,
            &nonce,
        );
        let mut delivered = Vec::new();
        let mut close_error = None;
        let outcome = match &result {
            Ok(connection) => {
                loop {
                    match connection.recv(Some(Duration::from_millis(50))) {
                        Ok(Message::Json(value)) => delivered.push(value),
                        Ok(Message::Binary(data)) => panic!("{name}: 意外的二进制帧 {data:?}"),
                        Err(error) if error.code() == ErrorCode::Timeout => break,
                        Err(error) => {
                            close_error = Some(error.code().as_str());
                            break;
                        }
                    }
                }
                "open"
            }
            Err(error) => error.code().as_str(),
        };
        assert_eq!(outcome, str_of(case, "result"), "{name}");
        assert_eq!(close_error, case["close_error"].as_str(), "{name}");
        let expected: Vec<Value> = case["delivered"]
            .as_array()
            .expect("delivered")
            .iter()
            .map(|d| serde_json::from_str(str_of(d, "json")).expect("json"))
            .collect();
        assert_eq!(delivered, expected, "{name}");
        assert_eq!(peer.drain(), frames_hex(&case["output"]), "{name}");
    }
}

impl MemoryTransport {
    fn write_all_bytes(&self, bytes: &[u8]) {
        crate::transport::Transport::write_all(self, bytes, None).expect("内存写入");
    }
}

fn next_frame(peer: &MemoryTransport, buffer: &mut FrameDecoder) -> Vec<u8> {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(frame) = buffer.read().expect("合法帧") {
            return encode_frame(frame.kind, &frame.payload);
        }
        let mut chunk = [0u8; 4096];
        let count = crate::transport::Transport::read(peer, &mut chunk, Some(deadline))
            .expect("对端写来数据");
        assert!(count > 0, "对端已关闭");
        buffer.push(&chunk[..count]);
    }
}

fn params_of(step: &Value) -> Option<Map<String, Value>> {
    step["params"].as_object().cloned()
}

#[test]
fn client_rpc_session() {
    let session = &VECTORS["session"];
    let key = key32(str_of(session, "key_hex"));
    let (local, peer) = MemoryTransport::pair();
    let handshake = session["handshake"].as_array().expect("handshake");
    for frame in handshake.iter().filter(|f| str_of(f, "from") == "server") {
        peer.write_all_bytes(&hex(str_of(frame, "frame_hex")));
    }
    let connection = Connection::open_with_nonce(
        Box::new(local),
        str_of(session, "role"),
        &key,
        &ConnectionOptions::default(),
        &key32(str_of(session, "client_nonce_hex")),
    )
    .expect("握手成功");
    let mut decoder = FrameDecoder::new(usize::MAX);
    for frame in handshake.iter().filter(|f| str_of(f, "from") == "client") {
        assert_eq!(
            next_frame(&peer, &mut decoder),
            hex(str_of(frame, "frame_hex"))
        );
    }

    let handlers = Handlers::new().request("host.ping", |_| Ok(Value::Null));
    let rpc = Arc::new(
        RpcPeer::spawn(
            connection,
            handlers,
            &RpcOptions {
                timeout: Duration::from_secs(1),
            },
        )
        .expect("读线程"),
    );
    for step in session["rpc"].as_array().expect("rpc") {
        let name = str_of(step, "name");
        let action = (str_of(step, "actor") == "client").then(|| {
            let rpc = Arc::clone(&rpc);
            let step = step.clone();
            thread::spawn(move || client_action(&rpc, &step))
        });
        let raw = str_of(step, "call") == "raw";
        for frame in step["frames"].as_array().expect("frames") {
            let expected = hex(str_of(frame, "frame_hex"));
            if str_of(frame, "from") == "client" {
                let actual = next_frame(&peer, &mut decoder);
                if raw {
                    let parse = |bytes: &[u8]| -> Value {
                        serde_json::from_slice(&bytes[FRAME_HEADER_BYTES..]).expect("json")
                    };
                    assert_eq!(parse(&actual), parse(&expected), "{name}");
                } else {
                    assert_eq!(
                        actual,
                        expected,
                        "{name}: {}",
                        String::from_utf8_lossy(&actual)
                    );
                }
            } else {
                peer.write_all_bytes(&expected);
            }
        }
        if let Some(Some(result)) = action.map(|handle| handle.join().expect("请求线程")) {
            check_result(step, result);
        }
    }
    rpc.close();
    assert!(rpc.wait_closed(Some(Duration::from_secs(1))).is_some());
}

fn client_action(rpc: &RpcPeer, step: &Value) -> Option<Result<Value, CallError>> {
    let params = params_of(step);
    match str_of(step, "call") {
        "raw" => rpc.connection().send(&step["raw"]).expect("发送"),
        "notify" => rpc
            .notify(str_of(step, "method"), params.as_ref())
            .expect("通知"),
        "request" => {
            let timeout = step["timeout_ms"]
                .as_u64()
                .map_or(Duration::from_secs(1), Duration::from_millis);
            return Some(rpc.request_with_timeout(
                str_of(step, "method"),
                params.as_ref(),
                timeout,
            ));
        }
        other => panic!("客户端不做 {other}"),
    }
    None
}

fn check_result(step: &Value, result: Result<Value, CallError>) {
    let name = str_of(step, "name");
    match (&step["error"], result) {
        (Value::Null, Ok(value)) => assert_eq!(value, step["result"], "{name}"),
        (expected, Err(CallError::Rpc(error))) => {
            let rpc = &expected["rpc"];
            assert_eq!(Some(error.code), rpc["code"].as_i64(), "{name}");
            assert_eq!(error.message, str_of(rpc, "message"), "{name}");
            assert_eq!(error.data.unwrap_or(Value::Null), rpc["data"], "{name}");
        }
        (expected, Err(CallError::Channel(error))) => {
            assert_eq!(
                Some(error.code().as_str()),
                expected["channel"].as_str(),
                "{name}"
            );
        }
        (expected, Ok(value)) => panic!("{name}: 期望 {expected}，得到 {value}"),
    }
}

#[test]
fn json_roundtrip_matches_compact_utf8() {
    let value: Value = serde_json::from_str(r#"{"text":"你好"}"#).expect("json");
    assert_eq!(json::dumps(&value), r#"{"text":"你好"}"#.as_bytes());
}
