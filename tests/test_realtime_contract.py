"""Cross-language fixture contract tests: RPC messages, ring layouts, and CredMan SessionInfo."""

from __future__ import annotations

import ctypes
import json
from pathlib import Path
from typing import Any

import pytest
from bellis_common.channel import classify
from bellis_common.cred import CredError, SessionInfo
from bellis_game.io import audio_ring, frame_ring
from bellis_game.io.audio_ring import (
    AudioBlockHeader,
    AudioRing,
    AudioRingCorruptError,
    AudioRingHeader,
    AudioRingTornError,
)
from bellis_game.io.frame_ring import (
    FrameRing,
    FrameRingCorruptError,
    FrameRingHeader,
    FrameRingTornError,
    FrameSlotHeader,
)
from bellis_game.io.protocol import (
    PROTOCOL_VERSION,
    ActionBlock,
    ActionReceiptParams,
    AudioRingAttachParams,
    CoreErrorCode,
    CoreHelloParams,
    CoreHelloResult,
    CoreMethods,
    Empty,
    FrameRingAttachParams,
    HealthParams,
    InputPolicy,
    InputReleasedParams,
    InputStopParams,
    InputStopResult,
    LeaseRenewParams,
    LeaseRevokeParams,
    PermitMethods,
    Producer,
    ProducerHeartbeatParams,
    ProducerRevokeParams,
    ProducerRevokeResult,
    ProtocolError,
    WindowTargetParams,
    parse_action_submit_result,
)

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "realtime_core"


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))


def _assert_roundtrip(cls: Any, payload: dict[str, Any], name: str) -> None:
    parsed = cls.from_dict(payload)
    assert parsed.to_dict() == payload, f"{name}: roundtrip mismatch"
    mutated = dict(payload)
    mutated["__unexpected_extra_field__"] = 1
    with pytest.raises(ProtocolError):
        cls.from_dict(mutated)


def test_permit_rpc_fixture_roundtrip_and_strictness() -> None:
    doc = _load_fixture("permit_rpc.json")
    assert doc["protocol_version"] == PROTOCOL_VERSION
    assert doc["error_codes"]["LEASE_REFUSED"] == CoreErrorCode.LEASE_REFUSED

    seen_methods: set[str] = set()
    for case in doc["cases"]:
        name: str = case["name"]
        kind: str = case["kind"]
        method: str = case["method"]
        envelope: dict[str, Any] = case["envelope"]
        assert classify(envelope) == kind, name
        seen_methods.add(method)

        if (kind, method) == ("request", PermitMethods.LEASE_RENEW):
            _assert_roundtrip(LeaseRenewParams, envelope["params"], name)
        elif (kind, method) in {
            ("success", PermitMethods.LEASE_RENEW),
            ("success", PermitMethods.LEASE_REVOKE),
        }:
            _assert_roundtrip(Empty, envelope["result"], name)
        elif (kind, method) == ("failure", PermitMethods.LEASE_RENEW):
            assert envelope["error"]["code"] == CoreErrorCode.LEASE_REFUSED
        elif (kind, method) == ("request", PermitMethods.LEASE_REVOKE):
            _assert_roundtrip(LeaseRevokeParams, envelope["params"], name)
        elif (kind, method) == ("request", PermitMethods.INPUT_STOP):
            _assert_roundtrip(InputStopParams, envelope["params"], name)
        elif (kind, method) == ("success", PermitMethods.INPUT_STOP):
            _assert_roundtrip(InputStopResult, envelope["result"], name)
        elif (kind, method) == ("notification", PermitMethods.INPUT_RELEASED):
            _assert_roundtrip(InputReleasedParams, envelope["params"], name)
        elif (kind, method) == ("notification", PermitMethods.HEALTH):
            _assert_roundtrip(HealthParams, envelope["params"], name)
        else:
            pytest.fail(f"unhandled permit fixture case {name}: {(kind, method)}")

    assert seen_methods == {
        PermitMethods.LEASE_RENEW,
        PermitMethods.LEASE_REVOKE,
        PermitMethods.INPUT_STOP,
        PermitMethods.INPUT_RELEASED,
        PermitMethods.HEALTH,
    }


def test_core_rpc_fixture_roundtrip_and_strictness() -> None:
    doc = _load_fixture("core_rpc.json")
    assert doc["protocol_version"] == PROTOCOL_VERSION
    assert doc["error_codes"] == {
        "PROTOCOL_VERSION_MISMATCH": CoreErrorCode.PROTOCOL_VERSION_MISMATCH,
        "FRAME_RING_MISMATCH": CoreErrorCode.FRAME_RING_MISMATCH,
        "CAPTURE_UNSUPPORTED": CoreErrorCode.CAPTURE_UNSUPPORTED,
        "AUDIO_RING_MISMATCH": CoreErrorCode.AUDIO_RING_MISMATCH,
        "INPUT_POLICY_CONFLICT": CoreErrorCode.INPUT_POLICY_CONFLICT,
    }

    seen_methods: set[str] = set()
    for case in doc["cases"]:
        name: str = case["name"]
        kind: str = case["kind"]
        method: str = case["method"]
        envelope: dict[str, Any] = case["envelope"]
        assert classify(envelope) == kind, name
        seen_methods.add(method)

        if (kind, method) == ("request", CoreMethods.CORE_HELLO):
            _assert_roundtrip(CoreHelloParams, envelope["params"], name)
        elif (kind, method) == ("success", CoreMethods.CORE_HELLO):
            _assert_roundtrip(CoreHelloResult, envelope["result"], name)
        elif (kind, method) == ("failure", CoreMethods.CORE_HELLO):
            assert envelope["error"]["code"] == CoreErrorCode.PROTOCOL_VERSION_MISMATCH
        elif (kind, method) == ("request", CoreMethods.FRAME_RING_ATTACH):
            _assert_roundtrip(FrameRingAttachParams, envelope["params"], name)
        elif kind == "request" and method in {
            CoreMethods.CAPTURE_SET_TARGET,
            CoreMethods.AUDIO_SET_TARGET,
        }:
            _assert_roundtrip(WindowTargetParams, envelope["params"], name)
        elif (kind, method) == ("request", CoreMethods.AUDIO_RING_ATTACH):
            _assert_roundtrip(AudioRingAttachParams, envelope["params"], name)
        elif (kind, method) == ("request", CoreMethods.INPUT_CONFIGURE):
            _assert_roundtrip(InputPolicy, envelope["params"], name)
        elif (kind, method) == ("failure", CoreMethods.INPUT_CONFIGURE):
            assert envelope["error"]["code"] == CoreErrorCode.INPUT_POLICY_CONFLICT
        elif (kind, method) == ("notification", CoreMethods.PRODUCER_HEARTBEAT):
            _assert_roundtrip(ProducerHeartbeatParams, envelope["params"], name)
        elif (kind, method) == ("request", CoreMethods.PRODUCER_REVOKE):
            _assert_roundtrip(ProducerRevokeParams, envelope["params"], name)
        elif (kind, method) == ("success", CoreMethods.PRODUCER_REVOKE):
            _assert_roundtrip(ProducerRevokeResult, envelope["result"], name)
        elif (kind, method) == ("request", CoreMethods.ACTION_SUBMIT):
            _assert_roundtrip(ActionBlock, envelope["params"], name)
        elif (kind, method) == ("success", CoreMethods.ACTION_SUBMIT):
            parsed = parse_action_submit_result(envelope["result"])
            assert parsed.to_dict() == envelope["result"], name
            with pytest.raises(ProtocolError):
                parse_action_submit_result({**envelope["result"], "extra": 1})
        elif (kind, method) == ("notification", CoreMethods.ACTION_RECEIPT):
            _assert_roundtrip(ActionReceiptParams, envelope["params"], name)
        elif (kind, method) == ("notification", CoreMethods.INPUT_RELEASED):
            _assert_roundtrip(InputReleasedParams, envelope["params"], name)
        elif (kind, method) == ("notification", CoreMethods.HEALTH):
            _assert_roundtrip(HealthParams, envelope["params"], name)
        elif (kind, method) == ("request", CoreMethods.SHUTDOWN):
            _assert_roundtrip(Empty, envelope["params"], name)
        elif kind == "success" and method in {
            CoreMethods.FRAME_RING_ATTACH,
            CoreMethods.CAPTURE_SET_TARGET,
            CoreMethods.AUDIO_RING_ATTACH,
            CoreMethods.AUDIO_SET_TARGET,
            CoreMethods.INPUT_CONFIGURE,
            CoreMethods.SHUTDOWN,
        }:
            _assert_roundtrip(Empty, envelope["result"], name)
        else:
            pytest.fail(f"unhandled core fixture case {name}: {(kind, method)}")

    assert seen_methods == {
        CoreMethods.CORE_HELLO,
        CoreMethods.FRAME_RING_ATTACH,
        CoreMethods.CAPTURE_SET_TARGET,
        CoreMethods.AUDIO_RING_ATTACH,
        CoreMethods.AUDIO_SET_TARGET,
        CoreMethods.INPUT_CONFIGURE,
        CoreMethods.PRODUCER_HEARTBEAT,
        CoreMethods.PRODUCER_REVOKE,
        CoreMethods.ACTION_SUBMIT,
        CoreMethods.ACTION_RECEIPT,
        CoreMethods.INPUT_RELEASED,
        CoreMethods.HEALTH,
        CoreMethods.SHUTDOWN,
    }


def test_protocol_rejects_bad_timestamps_and_types() -> None:
    with pytest.raises(ProtocolError):
        LeaseRenewParams.from_dict({"token": True, "expires_ns": 100})
    with pytest.raises(ProtocolError):
        LeaseRenewParams.from_dict({"token": 1, "expires_ns": -1})
    with pytest.raises(ProtocolError):
        ActionBlock.from_dict(
            {
                "producer": Producer("a", 1).to_dict(),
                "seq": 1,
                "base_frame": 1,
                "start_ns": 200,
                "deadline_ns": 100,
                "steps": [],
            }
        )
    bad_steps: dict[str, Any] = {
        "producer": Producer("a", 1).to_dict(),
        "seq": 1,
        "base_frame": 1,
        "start_ns": 100,
        "deadline_ns": 500,
        "steps": [
            {"offset_ns": 50, "held": [], "actions": []},
            {"offset_ns": 10, "held": [], "actions": []},
        ],
    }
    with pytest.raises(ProtocolError):
        ActionBlock.from_dict(bad_steps)


def _check_struct_layout(struct_cls: type[ctypes.Structure], spec: dict[str, Any]) -> None:
    assert ctypes.sizeof(struct_cls) == spec["size"], struct_cls.__name__
    assert ctypes.alignment(struct_cls) == spec["align"], struct_cls.__name__
    for field in spec["fields"]:
        descriptor = getattr(struct_cls, field["name"])
        assert descriptor.offset == field["offset"], f"{struct_cls.__name__}.{field['name']}"
        assert descriptor.size == field["size"], f"{struct_cls.__name__}.{field['name']}"


def test_ring_layouts_match_fixture_byte_for_byte() -> None:
    doc = _load_fixture("ring_layout.json")

    fr = doc["frame_ring"]
    fc = fr["constants"]
    assert fc["MAGIC"] == frame_ring.MAGIC
    assert frame_ring.MAGIC.to_bytes(8, "little").decode("ascii") == fc["MAGIC_ASCII"]
    assert fc["LAYOUT_VERSION"] == frame_ring.LAYOUT_VERSION
    assert fc["SLOTS_OFFSET"] == frame_ring.SLOTS_OFFSET
    assert fc["SLOT_PIXELS_OFFSET"] == frame_ring.SLOT_PIXELS_OFFSET
    assert fc["SLOT_ALIGN"] == frame_ring.SLOT_ALIGN
    assert fc["PIXEL_FORMAT_BGRA8"] == frame_ring.PIXEL_FORMAT_BGRA8
    _check_struct_layout(FrameRingHeader, fr["structs"]["FrameRingHeader"])
    _check_struct_layout(FrameSlotHeader, fr["structs"]["FrameSlotHeader"])

    ar = doc["audio_ring"]
    ac = ar["constants"]
    assert ac["MAGIC"] == audio_ring.MAGIC
    assert audio_ring.MAGIC.to_bytes(8, "little").decode("ascii") == ac["MAGIC_ASCII"]
    assert ac["LAYOUT_VERSION"] == audio_ring.LAYOUT_VERSION
    assert ac["BLOCKS_OFFSET"] == audio_ring.BLOCKS_OFFSET
    assert ac["BLOCK_SAMPLES_OFFSET"] == audio_ring.BLOCK_SAMPLES_OFFSET
    assert ac["BLOCK_ALIGN"] == audio_ring.BLOCK_ALIGN
    assert ac["SAMPLE_FORMAT_F32"] == audio_ring.SAMPLE_FORMAT_F32
    assert ac["BYTES_PER_VALUE"] == audio_ring.BYTES_PER_VALUE
    assert ac["MAX_CHANNELS"] == audio_ring.MAX_CHANNELS
    assert ac["MIN_SAMPLE_RATE"] == audio_ring.MIN_SAMPLE_RATE
    assert ac["MAX_SAMPLE_RATE"] == audio_ring.MAX_SAMPLE_RATE
    assert ac["FLAG_DISCONTINUITY"] == audio_ring.FLAG_DISCONTINUITY
    assert ac["KNOWN_FLAGS"] == audio_ring.KNOWN_FLAGS
    _check_struct_layout(AudioRingHeader, ar["structs"]["AudioRingHeader"])
    _check_struct_layout(AudioBlockHeader, ar["structs"]["AudioBlockHeader"])


def test_frame_and_audio_rings_seqlock_read_and_errors() -> None:
    with FrameRing.create(8, 4, slot_count=3) as ring:
        assert ring.read_latest() is None
        buf = ring._memory.buffer  # pyright: ignore[reportPrivateUsage]
        header = FrameRingHeader.from_buffer(buf, 0)
        slot0 = FrameSlotHeader.from_buffer(buf, frame_ring.SLOTS_OFFSET)
        pixels = bytes(range(8 * 4 * 4))
        slot0.seq = 1
        slot0.frame_number = 1
        slot0.capture_ns = 12345
        slot0.transform_version = 2
        slot0.width = 8
        slot0.height = 4
        slot0.row_stride = 32
        slot0.pixel_format = frame_ring.PIXEL_FORMAT_BGRA8
        p_start = frame_ring.SLOTS_OFFSET + frame_ring.SLOT_PIXELS_OFFSET
        buf[p_start : p_start + len(pixels)] = pixels
        slot0.seq = 2
        header.write_seq = 1

        got = ring.read_latest()
        assert got is not None
        assert (got.frame_number, got.capture_ns, got.width, got.height) == (1, 12345, 8, 4)
        assert got.pixels == pixels

        # Odd seq -> torn error.
        slot0.seq = 3
        with pytest.raises(FrameRingTornError):
            ring.read_latest(max_attempts=2)

        # Stable invalid pixel_format -> corrupt error.
        slot0.pixel_format = 99
        slot0.seq = 4
        with pytest.raises(FrameRingCorruptError):
            ring.read_latest(max_attempts=2)
        del slot0, header

    with AudioRing.create(48_000, 2, block_capacity=16, block_count=4) as ring:
        assert ring.read_recent(1_000_000).blocks == ()
        buf = ring._memory.buffer  # pyright: ignore[reportPrivateUsage]
        header = AudioRingHeader.from_buffer(buf, 0)
        blk0 = AudioBlockHeader.from_buffer(buf, audio_ring.BLOCKS_OFFSET)
        raw_samples = b"\x00\x00\x80?" * 8  # 4 stereo f32 frames
        blk0.seq = 1
        blk0.block_number = 1
        blk0.capture_ns = 55555
        blk0.sample_count = 4
        blk0.flags = audio_ring.FLAG_DISCONTINUITY
        s_start = audio_ring.BLOCKS_OFFSET + audio_ring.BLOCK_SAMPLES_OFFSET
        buf[s_start : s_start + len(raw_samples)] = raw_samples
        blk0.seq = 2
        header.write_seq = 1

        read = ring.read_recent(1_000_000)
        assert len(read.blocks) == 1
        assert read.blocks[0].discontinuity is True
        assert read.blocks[0].samples == raw_samples

        blk0.seq = 3
        with pytest.raises(AudioRingTornError):
            ring.read_recent(1_000_000, max_attempts=2)

        blk0.flags = 0xFF
        blk0.seq = 4
        with pytest.raises(AudioRingCorruptError):
            ring.read_recent(1_000_000, max_attempts=2)
        del blk0, header


def test_session_info_fixture_utf16le_roundtrip_and_invalid_cases() -> None:
    doc = _load_fixture("session_info.json")
    assert doc["credential_type"] == "CRED_TYPE_GENERIC"
    assert doc["credential_encoding"] == "utf-16le"

    valid = doc["valid"]
    info = SessionInfo.from_dict(valid)
    assert info.to_dict() == valid
    assert valid["channelKey"] not in repr(info)

    blob = info.to_utf16le()
    assert len(blob) % 2 == 0
    assert SessionInfo.from_utf16le(blob) == info

    assert len(doc["invalid"]) == 6
    for case in doc["invalid"]:
        with pytest.raises(CredError, match="SessionInfo"):
            SessionInfo.from_dict(case["payload"])

    with pytest.raises(CredError):
        SessionInfo.from_utf16le(b"")
    with pytest.raises(CredError):
        SessionInfo.from_utf16le(b"\x00")
    with pytest.raises(CredError):
        SessionInfo.from_json("[]")
