"""Cross-language vector tests and Windows named-pipe tests for ``bellis_common.channel``."""

from __future__ import annotations

import asyncio
import json
import secrets
from pathlib import Path
from typing import Any, cast

import pytest
from bellis_common.channel import (
    CLOSE_GRACE,
    DEFAULT_HANDSHAKE_TIMEOUT,
    DEFAULT_MAX_FRAME_BYTES,
    DEFAULT_MAX_INFLIGHT,
    DEFAULT_MAX_PENDING_HANDSHAKES,
    FRAME_HEADER_BYTES,
    HANDSHAKE_MAX_FRAME_BYTES,
    MAX_UDS_PATH_BYTES,
    PIPE_PREFIX,
    PROOF_DOMAIN,
    SESSION_KEY_BYTES,
    ChannelError,
    ClientHandshake,
    Connection,
    Frame,
    FrameDecoder,
    FrameKind,
    JsonMessage,
    RpcError,
    RpcPeer,
    ServerHandshake,
    b64url,
    cancel_target,
    channel_name,
    classify,
    connect,
    create_channel_path,
    create_session_key,
    decode_session_key,
    dumps,
    encode_frame,
    encode_session_key,
    is_accept,
    is_method,
    listen,
    loads,
    mac,
    parse_challenge,
    parse_hello,
    parse_proof,
)
from bellis_common.telemetry import JsonlTelemetry

type Vectors = dict[str, Any]

REPO_ROOT = Path(__file__).resolve().parent.parent
VECTORS_PATH = REPO_ROOT / "core" / "crates" / "channel" / "testdata" / "vectors.json"


@pytest.fixture(scope="module")
def vectors() -> Vectors:
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


def test_constants_match_vectors(vectors: Vectors) -> None:
    constants = vectors["constants"]
    assert constants["proof_domain"] == PROOF_DOMAIN
    assert constants["frame_header_bytes"] == FRAME_HEADER_BYTES
    assert constants["handshake_max_frame_bytes"] == HANDSHAKE_MAX_FRAME_BYTES
    assert constants["default_max_frame_bytes"] == DEFAULT_MAX_FRAME_BYTES
    assert constants["default_handshake_timeout_ms"] == DEFAULT_HANDSHAKE_TIMEOUT * 1000
    assert constants["close_grace_ms"] == CLOSE_GRACE * 1000
    assert constants["default_max_pending_handshakes"] == DEFAULT_MAX_PENDING_HANDSHAKES
    assert constants["default_rpc_max_inflight"] == DEFAULT_MAX_INFLIGHT
    assert constants["session_key_bytes"] == SESSION_KEY_BYTES
    assert constants["max_uds_path_bytes"] == MAX_UDS_PATH_BYTES


def test_frames_encode_and_decode(vectors: Vectors) -> None:
    for vector in vectors["frames"]:
        frame = encode_frame(FrameKind(vector["kind"]), bytes.fromhex(vector["payload_hex"]))
        assert frame.hex() == vector["frame_hex"]

    for case in vectors["decoder"]:
        decoder = FrameDecoder(case["max_payload_bytes"])
        decoder.push(bytes.fromhex(case["input_hex"]))
        frames: list[dict[str, object]] = []
        error = None
        try:
            while (frame := decoder.read()) is not None:
                frames.append({"kind": frame.kind, "payload_hex": frame.payload.hex()})
        except ChannelError as caught:
            error = caught.code
        assert frames == case["frames"], case["name"]
        assert error == case["error"], case["name"]
        if case["buffered_bytes"] is not None:
            assert decoder.buffered_bytes == case["buffered_bytes"], case["name"]


def test_channel_names_and_session_keys(vectors: Vectors) -> None:
    address = vectors["address"]
    random = bytes.fromhex(address["random_hex"])
    windows = address["windows"]
    assert PIPE_PREFIX + channel_name(windows["session_id"], random) == windows["path"]
    for case in address["session_ids"]:
        if case["valid"]:
            channel_name(case["session_id"], random)
        else:
            with pytest.raises(ChannelError) as raised:
                channel_name(case["session_id"], random)
            assert raised.value.code == "address-invalid"

    for case in address["session_keys"]:
        if case["key_hex"] is None:
            with pytest.raises(ChannelError) as raised:
                decode_session_key(case["text"])
            assert raised.value.code == "address-invalid"
        else:
            key = decode_session_key(case["text"])
            assert key.hex() == case["key_hex"]
            assert encode_session_key(key) == case["text"]


def test_handshake_message_validation_and_payloads(vectors: Vectors) -> None:
    messages = vectors["messages"]
    for case in messages["hello"]:
        assert (parse_hello(json.loads(case["json"])) is not None) == case["valid"], case["json"]
    for case in messages["challenge"]:
        valid = parse_challenge(json.loads(case["json"])) is not None
        assert valid == case["valid"], case["json"]
    for case in messages["proof"]:
        assert (parse_proof(json.loads(case["json"])) is not None) == case["valid"], case["json"]
    for case in messages["accept"]:
        assert is_accept(json.loads(case["json"])) == case["valid"], case["json"]

    for case in vectors["payloads"]:
        payload = bytes.fromhex(case["payload_hex"])
        if case["valid"]:
            assert loads(payload) == json.loads(case["value_json"]), case["name"]
        else:
            with pytest.raises(ChannelError) as raised:
                loads(payload)
            assert raised.value.code == case["error"], case["name"]


def test_rpc_classification_and_v2_single_segment_methods(vectors: Vectors) -> None:
    for case in vectors["messages"]["rpc"]:
        message: object = json.loads(case["json"])
        # V2 extension: single-segment lowercase methods (health, shutdown, nodot) are valid.
        if isinstance(message, dict) and cast("dict[str, Any]", message).get("method") == "nodot":
            assert classify(cast("object", message)) == "request", case["json"]
            continue
        assert classify(cast("object", message)) == case["kind"], case["json"]

    for case in vectors["messages"]["cancel_params"]:
        valid = cancel_target(json.loads(case["json"])) is not None
        assert valid == case["valid"], case["json"]

    assert is_method("health")
    assert is_method("shutdown")
    assert is_method("lease.renew")
    assert is_method("a.b_1.c")
    for bad in ("", "Health", "Bad Name", "a..b", ".a", "a.", "_a", "1a", 123, None):
        assert not is_method(bad), repr(bad)
    assert classify({"jsonrpc": "2.0", "id": 1, "method": "shutdown", "params": {}}) == "request"
    assert classify({"jsonrpc": "2.0", "method": "health", "params": {}}) == "notification"


def _frames_bytes(frames: list[dict[str, Any]]) -> bytes:
    return b"".join(bytes.fromhex(frame["frame_hex"]) for frame in frames)


def _single_frame(hex_text: str) -> Frame:
    decoder = FrameDecoder(1 << 32)
    decoder.push(bytes.fromhex(hex_text))
    frame = decoder.read()
    assert frame is not None
    return frame


def test_session_handshake_exact_bytes(vectors: Vectors) -> None:
    session = vectors["session"]
    key = bytes.fromhex(session["key_hex"])
    role = session["role"]
    hello, challenge, proof, accept = (frame["frame_hex"] for frame in session["handshake"])

    client = ClientHandshake(key, role, bytes.fromhex(session["client_nonce_hex"]))
    assert client.hello().hex() == hello
    assert client.on_challenge(_single_frame(challenge)).hex() == proof
    client.on_accept(_single_frame(accept))

    server = ServerHandshake(key, bytes.fromhex(session["server_nonce_hex"]))
    assert server.on_hello(_single_frame(hello)).hex() == challenge
    assert server.on_proof(_single_frame(proof)) == (role, bytes.fromhex(accept))

    client_nonce = b64url(bytes.fromhex(session["client_nonce_hex"]))
    server_nonce = b64url(bytes.fromhex(session["server_nonce_hex"]))
    record = dumps([PROOF_DOMAIN, "server", role, client_nonce, server_nonce]).decode()
    assert record == session["mac_record"]
    expected = json.loads(session["handshake"][1]["text"])["proof"]
    assert b64url(mac(key, "server", role, client_nonce, server_nonce)) == expected


class _MemoryTransport(asyncio.Transport):
    def __init__(self, protocol: asyncio.StreamReaderProtocol) -> None:
        super().__init__()
        self.written = bytearray()
        self._protocol = protocol
        self._closing = False

    def write(self, data: bytes | bytearray | memoryview) -> None:
        if not self._closing:
            self.written += data

    def is_closing(self) -> bool:
        return self._closing

    def close(self) -> None:
        if not self._closing:
            self._closing = True
            asyncio.get_running_loop().call_soon(self._protocol.connection_lost, None)

    def abort(self) -> None:
        self.close()

    def can_write_eof(self) -> bool:
        return False

    def get_write_buffer_size(self) -> int:
        return 0


def _memory_streams() -> tuple[asyncio.StreamReader, asyncio.StreamWriter, _MemoryTransport]:
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    transport = _MemoryTransport(protocol)
    protocol.connection_made(transport)
    writer = asyncio.StreamWriter(transport, protocol, reader, asyncio.get_running_loop())
    return reader, writer, transport


async def _run_handshake_case(case: dict[str, Any], key: bytes) -> dict[str, Any]:
    reader, writer, transport = _memory_streams()
    reader.feed_data(b"".join(bytes.fromhex(chunk) for chunk in case["input_hex"]))
    if case["end"]:
        reader.feed_eof()
    options: dict[str, Any] = {
        "max_frame_bytes": case["max_frame_bytes"],
        "handshake_timeout": 1.0,
        "nonce": bytes.fromhex(case["nonce_hex"]),
    }
    delivered: list[str] = []
    close_error = None
    try:
        if case["side"] == "server":
            connection = await Connection.accept(reader, writer, key, **options)
        else:
            connection = await Connection.open(reader, writer, case["role"], key, **options)
    except ChannelError as error:
        result = error.code
    else:
        result = "open"
        while True:
            try:
                message = await connection.receive(timeout=0.05)
            except ChannelError as error:
                close_error = None if error.code == "timeout" else error.code
                break
            assert isinstance(message, JsonMessage)
            delivered.append(json.dumps(message.value, separators=(",", ":")))
        await connection.close()
    return {
        "result": result,
        "close_error": close_error,
        "delivered": [{"json": text} for text in delivered],
        "output": bytes(transport.written).hex(),
    }


async def test_all_handshake_vector_cases(vectors: Vectors) -> None:
    key = bytes.fromhex(vectors["session"]["key_hex"])
    for case in vectors["handshake_cases"]:
        outcome = await _run_handshake_case(case, key)
        expected = {
            "result": case["result"],
            "close_error": case["close_error"],
            "delivered": case["delivered"],
            "output": _frames_bytes(case["output"]).hex(),
        }
        assert outcome == expected, f"{case['side']} {case['name']}"


async def _wait_written(transport: _MemoryTransport, expected: bytes, step: str) -> None:
    async with asyncio.timeout(2):
        while len(transport.written) < len(expected):
            await asyncio.sleep(0.001)
    actual = bytes(transport.written[: len(expected)])
    del transport.written[: len(expected)]
    assert actual == expected, f"{step}: {actual!r}"


def _serve_vector_handlers(peer: RpcPeer, notifications: list[object]) -> None:
    def add(params: dict[str, Any]) -> object:
        return params["a"] + params["b"]

    def fail(_: dict[str, Any]) -> object:
        raise RpcError(1001, "不允许", {"reason": "x"})

    def crash(_: dict[str, Any]) -> object:
        raise RuntimeError("internal detail")

    async def hang(_: dict[str, Any]) -> object:
        await asyncio.Event().wait()
        return None

    peer.handle("math.add", add)
    peer.handle("a.fail", fail)
    peer.handle("a.crash", crash)
    peer.handle("a.hang", hang)
    peer.on_notification("host.heartbeat", notifications.append)


def _check_rpc_step_result(step: dict[str, Any], task: asyncio.Task[object]) -> None:
    error = step["error"]
    exception = task.exception()
    if error is None:
        assert exception is None, step["name"]
        assert task.result() == step["result"], step["name"]
    elif "rpc" in error:
        assert isinstance(exception, RpcError), step["name"]
        expected = error["rpc"]
        assert (exception.code, exception.message, exception.data) == (
            expected["code"],
            expected["message"],
            expected["data"],
        )
    else:
        assert isinstance(exception, ChannelError), step["name"]
        assert exception.code == error["channel"], step["name"]


async def _run_rpc_session(vectors: Vectors, side: str) -> list[object]:
    session = vectors["session"]
    key = bytes.fromhex(session["key_hex"])
    reader, writer, transport = _memory_streams()
    handshake = session["handshake"]
    reader.feed_data(_frames_bytes([f for f in handshake if f["from"] != side]))
    if side == "server":
        nonce = bytes.fromhex(session["server_nonce_hex"])
        connection = await Connection.accept(reader, writer, key, nonce=nonce)
    else:
        nonce = bytes.fromhex(session["client_nonce_hex"])
        connection = await Connection.open(reader, writer, session["role"], key, nonce=nonce)
    await _wait_written(transport, _frames_bytes([f for f in handshake if f["from"] == side]), "hs")

    peer = RpcPeer(connection, timeout=1.0)
    notifications: list[object] = []
    if side == "server":
        _serve_vector_handlers(peer, notifications)
    else:
        peer.handle("host.ping", lambda _: None)
    for step in session["rpc"]:
        task: asyncio.Task[object] | None = None
        if step["actor"] == side:
            call = step["call"]
            if call == "request":
                timeout = step.get("timeout_ms")
                req = peer.request(
                    step["method"],
                    step["params"],
                    timeout=None if timeout is None else timeout / 1000,
                )
                task = asyncio.create_task(req)
            elif call == "notify":
                peer.notify(step["method"], step["params"])
            elif call == "raw":
                connection.send(step["raw"])
            elif call == "binary":
                connection.send_binary(bytes.fromhex(step["binary_hex"]))
            else:
                raise AssertionError(call)
        for frame in step["frames"]:
            data = bytes.fromhex(frame["frame_hex"])
            if frame["from"] == side:
                await _wait_written(transport, data, step["name"])
            else:
                reader.feed_data(data)
        if task is not None:
            await asyncio.wait({task}, timeout=2)
            _check_rpc_step_result(step, task)
    assert not transport.written, bytes(transport.written)
    await peer.close()
    return notifications


async def test_rpc_session_vectors_as_server_and_client(vectors: Vectors) -> None:
    notifications = await _run_rpc_session(vectors, "server")
    assert notifications == [{"seq": 7}, {}]
    await _run_rpc_session(vectors, "client")


async def test_windows_named_pipe_mutual_auth_and_rpc() -> None:
    path = create_channel_path(f"ch{secrets.token_hex(4)}")
    key = create_session_key()
    server_conn_fut: asyncio.Future[Connection] = asyncio.get_running_loop().create_future()
    rejected: list[ChannelError] = []
    errors: list[BaseException] = []

    def on_conn(conn: Connection) -> None:
        if not server_conn_fut.done():
            server_conn_fut.set_result(conn)

    server = await listen(
        path, key, on_connection=on_conn, on_rejected=rejected.append, on_error=errors.append
    )
    try:
        # Duplicate pipe name must fail with address-in-use (first-instance protection).
        with pytest.raises(ChannelError) as dup_exc:
            await listen(
                path,
                key,
                on_connection=on_conn,
                on_rejected=rejected.append,
                on_error=errors.append,
            )
        assert dup_exc.value.code == "address-in-use"

        # Wrong key must fail mutual auth on both sides.
        with pytest.raises(ChannelError) as bad_auth:
            await connect(path, "test.client", create_session_key(), handshake_timeout=1.0)
        assert bad_auth.value.code == "auth-failed"

        # Valid key succeeds and supports V2 single-segment RPC methods.
        client_conn = await connect(path, "realtime-core.core", key, handshake_timeout=2.0)
        server_conn = await asyncio.wait_for(server_conn_fut, timeout=2.0)
        assert server_conn.role == "realtime-core.core"

        server_peer = RpcPeer(server_conn, timeout=2.0)
        client_peer = RpcPeer(client_conn, timeout=2.0)
        with pytest.raises(ValueError, match="reserved"):
            server_peer.handle("rpc.custom", lambda _p: {})

        health_events: list[dict[str, Any]] = []
        server_peer.on_notification("health", health_events.append)
        client_peer.handle("shutdown", lambda _p: {"ok": True})

        client_peer.notify("health", {"seq": 1})
        reply = await server_peer.request("shutdown", {})
        assert reply == {"ok": True}
        assert health_events == [{"seq": 1}]

        await client_peer.close()
        await server_peer.close()
        assert errors == []
    finally:
        await server.close()


def test_jsonl_telemetry_writes_structured_records(tmp_path: Path) -> None:
    log_path = tmp_path / "telemetry.jsonl"
    with JsonlTelemetry(log_path) as telemetry:
        ev = telemetry.record("startup", dur_ms=1.25, ok=True, trace_id="abc123", attrs={"n": 1})
        assert ev["span"] == "startup"
        with telemetry.span("work", trace_id="abc123", attrs={"step": 2}) as attrs:
            attrs["done"] = True
        with pytest.raises(RuntimeError), telemetry.span("boom", trace_id="abc123"):
            raise RuntimeError("expected")

    lines = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
    assert len(lines) == 3
    assert lines[0]["span"] == "startup" and lines[0]["ok"] is True
    assert lines[1]["span"] == "work" and lines[1]["attrs"] == {"step": 2, "done": True}
    assert lines[2]["span"] == "boom" and lines[2]["ok"] is False
    assert lines[2]["attrs"]["error"] == "RuntimeError"
