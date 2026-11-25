import base64
import json
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import httpx2
import pytest
from bellis_common import cred
from bellis_common.telemetry import JsonlTelemetry
from bellis_game.io.frame_ring import RingFrame
from bellis_game.io.protocol import MouseButton, NormRect, WindowTargetParams
from bellis_game.perception import (
    FrameDiff,
    PixelRect,
    ProfileError,
    VlmClient,
    VlmConfig,
    VlmError,
    VlmUsage,
    encode_frame,
    frame_diff,
    load_game_profile,
    match_template_patch,
    norm_rect_to_pixels,
    parse_strict_json_object,
    resolve_vlm_api_key,
    ring_frame_to_rgb,
)
from PIL import Image

PROFILE = Path(__file__).resolve().parents[1] / "games" / "hsr.toml"
RIGHT = NormRect(0.5, 0, 1, 1)
CONFIG = VlmConfig("http://localhost:9999/v1", "test-model")


def solid(w: int, h: int, bgra: bytes = bytes(4)) -> RingFrame:
    return RingFrame(42, 1234, 5, w, h, w * 4, bgra * (w * h))


def test_padded_bgra_and_encoding() -> None:
    a, b, c, d = (
        bytes(row) for row in ((0, 0, 255, 0), (0, 255, 0, 10), (255, 0, 0, 20), (1, 2, 3, 255))
    )
    frame = RingFrame(42, 1234, 5, 2, 2, 11, a + b + b"pad" + c + d + b"end")
    rgb = ring_frame_to_rgb(frame)
    assert rgb.mode == "RGB"
    assert rgb.tobytes() == bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 3, 2, 1])
    encoded = encode_frame(frame, crop=RIGHT, image_format="png")
    assert encoded.data_url == f"data:image/png;base64,{encoded.base64_data}"
    assert base64.b64decode(encoded.base64_data, validate=True) == encoded.data
    with Image.open(BytesIO(encoded.data)) as im:
        assert (im.format, im.size) == ("PNG", (1, 2))
        assert im.tobytes() == bytes([0, 255, 0, 3, 2, 1])
    t = encoded.transform
    assert (t.frame_number, t.capture_ns, t.transform_version) == (42, 1234, 5)
    assert (t.source_width, t.source_height, t.crop) == (2, 2, PixelRect(1, 0, 2, 2))


@pytest.mark.parametrize(
    "args", [(0, 2, 4, 8), (1, -1, 4, 4), (2, 2, 7, 14), (2, 2, 8, 15), (2, 2, 8, 17)]
)
def test_bad_frame_layout(args: tuple[int, int, int, int]) -> None:
    w, h, stride, size = args
    with pytest.raises(ValueError):
        ring_frame_to_rgb(RingFrame(1, 2, 3, w, h, stride, bytes(size)))


@pytest.mark.parametrize(("w", "h", "dims"), [(80, 40, (8, 4)), (1, 40, (1, 8)), (3, 2, (3, 2))])
def test_proportional_jpeg(w: int, h: int, dims: tuple[int, int]) -> None:
    encoded = encode_frame(solid(w, h), max_long_edge=8)
    assert encoded.media_type == "image/jpeg"
    with Image.open(BytesIO(encoded.data)) as im:
        assert im.format == "JPEG" and im.size == dims
    assert (encoded.transform.encoded_width, encoded.transform.encoded_height) == dims


def test_crop_coordinates() -> None:
    roi = NormRect(0.25, 0.125, 0.75, 0.875)
    assert norm_rect_to_pixels(roi, 7, 7) == PixelRect(1, 0, 6, 7)
    t = encode_frame(solid(44, 8), crop=roi, max_long_edge=3).transform
    assert t.crop == PixelRect(11, 1, 33, 7)
    assert t.norm_to_client(0, 0) == (11, 1)
    assert t.norm_to_client(0.5, 0.5) == (22, 4)
    assert t.norm_to_client(1, 1) == (32, 6)
    for x in range(11, 33):
        for y in range(1, 7):
            assert t.norm_to_client(*t.client_to_norm(x, y)) == (x, y)
    for bad in [True, -0.0001, 1.0001, float("nan"), float("inf"), -float("inf")]:
        with pytest.raises(ValueError):
            t.norm_to_client(0, bad)
        with pytest.raises(ValueError):
            t.norm_to_client(bad, 1)
    for x, y in [(10, 1), (33, 1), (11, 0), (11, 7), (12, True)]:
        with pytest.raises(ValueError):
            t.client_to_norm(x, y)
    for args in [(0, 0, 0, 1), (0, -1, 2, 2), (0, True, 2, 2)]:
        with pytest.raises(ValueError):
            PixelRect(*args)
    with pytest.raises(ValueError):
        norm_rect_to_pixels(NormRect(0, 1, 1, 0), 2, 2)


def test_diff_and_template() -> None:
    before = solid(4, 2)
    white = bytes([255] * 4)
    after = replace(before, pixels=(bytes(8) + white * 2) * 2)
    assert frame_diff(before, after) == FrameDiff(0.5, 127.5, 4, 2)
    assert frame_diff(before, after, roi=RIGHT, sample_long_edge=1) == FrameDiff(1, 255, 1, 1)
    assert frame_diff(before, solid(4, 2, bytes([12, 0, 0, 255]))) == FrameDiff(0, 4, 4, 2)
    assert frame_diff(before, solid(4, 2, bytes([13, 0, 0, 255]))).changed_ratio == 1
    assert frame_diff(after, after).mean_abs_diff == 0
    mismatch = frame_diff(before, solid(2, 4))
    assert (mismatch.changed_ratio, mismatch.mean_abs_diff) == (1, 255)
    template = encode_frame(solid(9, 7, white), image_format="png").data
    assert match_template_patch(after, template, roi=RIGHT) == 1
    assert match_template_patch(before, template) == 0
    assert match_template_patch(after, template, sample_size=(4, 2)) == 0.5
    with pytest.raises(ValueError):
        match_template_patch(before, template, sample_size=(0, 2))


def test_hsr_profile() -> None:
    p = load_game_profile(PROFILE)
    assert (p.game_id, p.display_name) == ("hsr", "Honkai: Star Rail")
    assert p.window == WindowTargetParams("StarRail.exe", "UnityWndClass")
    assert (p.expected_width, p.expected_height) == (1920, 1080)
    assert p.scan_code_for("EsC") == 1 and p.scan_code_for("unknown") is None
    policy = p.input_policy
    assert policy.click_buttons == (MouseButton.LEFT,)
    assert policy.press_keys == (1, 28, 33, 50, 57, 62) and not policy.hold_keys
    assert (policy.scroll, policy.press_duration_ms, policy.max_rate) == (False, 60, 3)
    assert p.named_rois["full"] == NormRect(0, 0, 1, 1)
    assert p.point_allowed(10, 10, 1000, 1000)
    assert p.point_allowed(970, 25, 1000, 1000)
    for x, y in [(9, 10), (990, 500), (500, 990), (970, 24), (1000, 50), (-1, 10)]:
        assert not p.point_allowed(x, y, 1000, 1000)
    assert not p.point_allowed(0, 0, 0, 0)
    assert VlmConfig.from_profile(p.vlm) == VlmConfig(
        "https://ark.cn-beijing.volces.com/api/plan/v3", "deepseek-v4.1-flash"
    )


def test_profile_without_reasoning_effort(tmp_path: Path) -> None:
    path = tmp_path / "profile.toml"
    text = PROFILE.read_text(encoding="utf-8").replace('reasoning_effort = "low"\n', "")
    path.write_text(text, encoding="utf-8")
    vlm = load_game_profile(path).vlm
    assert vlm.reasoning_effort is None
    assert VlmConfig.from_profile(vlm).reasoning_effort is None


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("game_id =", "extra = 1\ngame_id ="),
        ("[rois]", "[other]"),
        ("[window]", "window = 1"),
        ('"StarRail.exe"', '""'),
        ("1920", "true"),
        ("esc = 1", "esc = 0"),
        ("f = 33", "f = 65536"),
        ("esc = 1", "esc = true"),
        ("esc = 1", "ESC = 2\nesc = 1"),
        ('["left"]', '["other"]'),
        ("scroll = false", "scroll = 0"),
        ("60", "501"),
        ("60", "0"),
        ("3.0", "nan"),
        ("3.0", "0.0"),
        ("right = 0.99", "right = 0.01"),
        ("top = 0.0,", "top = -0.1,"),
        ("full = { left = 0.0", "full = { left = 2.0"),
        ('"jpeg"', '"bmp"'),
        ('reasoning_effort = "low"', 'reasoning_effort = ""'),
        ("85", "101"),
        ("30.0", "inf"),
        ("1024", "0"),
        ("https://", "http://"),
        ('["ark.bellis", "ark.bellis-game-runtime"]', '"target"'),
        ('"hsr"', "["),
    ],
)
def test_invalid_profile(tmp_path: Path, old: str, new: str) -> None:
    text = PROFILE.read_text(encoding="utf-8")
    assert old in text
    path = tmp_path / "profile.toml"
    path.write_text(text.replace(old, new), encoding="utf-8")
    with pytest.raises(ProfileError):
        load_game_profile(path)


def test_read_secret_text(monkeypatch: pytest.MonkeyPatch) -> None:
    blob = Mock()
    monkeypatch.setattr(cred, "_read_cred_blob", blob)
    for raw, expected in [
        (None, None),
        (b"", ""),
        (" 密🔑\0x\0\0".encode("utf-16-le"), " 密🔑\0x"),
    ]:
        blob.return_value = raw
        assert cred.read_secret_text("test") == expected
        blob.assert_called_with("test")
    for raw in [b"x", b"\0\xd8"]:
        blob.return_value = raw
        with pytest.raises(cred.CredError, match="UTF-16LE"):
            cred.read_secret_text("test")


def test_resolve_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    reader = Mock(side_effect=[cred.CredError("unavailable"), "  ", "stored"])
    cfg = replace(CONFIG, cred_targets=("first", "second", "third"))
    env = {cfg.api_key_env: "environment"}
    assert (
        resolve_vlm_api_key(cfg, explicit_key="explicit", env=env, cred_reader=reader) == "explicit"
    )
    assert resolve_vlm_api_key(cfg, explicit_key=" ", env=env, cred_reader=reader) == "environment"
    reader.assert_not_called()
    monkeypatch.setattr(cred, "read_secret_text", reader)
    assert resolve_vlm_api_key(cfg, env={}) == "stored"
    assert [call.args for call in reader.call_args_list] == [(t,) for t in cfg.cred_targets]
    with pytest.raises(VlmError) as error:
        resolve_vlm_api_key(cfg, env={}, cred_reader=Mock(return_value=None))
    assert error.value.code == "missing_credentials"


@pytest.mark.parametrize(
    "url",
    [
        "http://example.org",
        "http://localhost.example",
        "http://127.0.0.1@example.org",
        "https:///path",
        "file://localhost/test",
        "invalid",
    ],
)
def test_invalid_endpoint(url: str) -> None:
    with pytest.raises(VlmError) as error:
        replace(CONFIG, base_url=url)
    assert error.value.code == "invalid_config"


@pytest.mark.parametrize("timeout", [0, True, float("nan"), float("inf")])
def test_invalid_timeout(timeout: float) -> None:
    with pytest.raises(VlmError) as error:
        replace(CONFIG, timeout_s=timeout)
    assert error.value.code == "invalid_config"


def test_strict_json_object() -> None:
    keys = frozenset({"a"})
    assert parse_strict_json_object(
        '  ```json\n{"a":[1]}\n```  ', required_keys=keys, allowed_keys=keys
    ) == {"a": [1]}
    for text in [
        '{"a":1,"a":2}',
        '{"x":[{"b":1,"b":2}]}',
        "prefix {}",
        "```json\n{}\n```\n```json\n{}\n```",
        "```json\n{}\n``` trailing",
        *('{"x":' + v + "}" for v in ("NaN", "Infinity", "-Infinity", "1e1000")),
    ]:
        with pytest.raises(VlmError) as error:
            parse_strict_json_object(text)
        assert error.value.code == "invalid_json"
    for text in ["[]", "null", "{}", '{"a":1,"b":2}']:
        with pytest.raises(VlmError) as error:
            parse_strict_json_object(text, required_keys=keys, allowed_keys=keys)
        assert error.value.code == "schema_error"


def reply(
    reason: str | None = "stop", content: str = '{"state":"private-result"}'
) -> httpx2.Response:
    return httpx2.Response(
        200,
        json={
            "id": "id",
            "created": 42,
            "object": "chat.completion",
            "model": "served",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": reason,
                    "message": {"role": "assistant", "content": content},
                }
            ],
            "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16},
        },
    )


@pytest.mark.parametrize("options", [True, False])
async def test_vlm_payload_and_close(options: bool, tmp_path: Path) -> None:
    image = encode_frame(solid(2, 3))
    payloads: list[dict[str, Any]] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        assert str(request.url) == "http://127.0.0.1:8765/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer private-api-key"
        payloads.append(json.loads(request.content))
        return reply("stop" if options else None)

    cfg = replace(
        CONFIG,
        base_url="http://127.0.0.1:8765/v1",
        response_format_json=options,
        reasoning_effort="low" if options else None,
    )
    path = tmp_path / "spans.jsonl"
    with JsonlTelemetry(path) as telemetry:
        async with VlmClient(
            cfg,
            api_key="private-api-key",
            telemetry=telemetry,
            transport=httpx2.MockTransport(handle),
        ) as client:
            result = await client.complete_json(
                system_prompt="private-system",
                user_text="private-user",
                image=image,
                required_keys=frozenset({"state"}),
                trace_id="trace",
            )
        with pytest.raises(VlmError) as error:
            await client.complete_json(system_prompt="", user_text="", image=image)
        assert error.value.code == "closed"
        await client.close()
    assert result.data == {"state": "private-result"} and json.loads(result.raw_text) == result.data
    assert result.model == "served" and result.finish_reason == ("stop" if options else None)
    assert result.usage == VlmUsage(12, 4, 16) and result.dur_ms >= 0
    (payload,) = payloads
    assert payload == {
        "model": CONFIG.model,
        "max_tokens": 1024,
        "messages": [
            {"role": "system", "content": "private-system"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "private-user"},
                    {"type": "image_url", "image_url": {"url": image.data_url}},
                ],
            },
        ],
        **(
            {"reasoning_effort": "low", "response_format": {"type": "json_object"}}
            if options
            else {}
        ),
    }
    log = path.read_text(encoding="utf-8")
    assert "private-" not in log and image.base64_data not in log
    success, closed = map(json.loads, log.splitlines())
    assert (success["span"], success["trace_id"], success["ok"]) == ("vlm.call", "trace", True)
    assert success["attrs"] == {
        "model": CONFIG.model,
        "finish_reason": result.finish_reason,
        "prompt_tokens": 12,
        "completion_tokens": 4,
    }
    assert closed["ok"] is False and closed["attrs"]["error_code"] == "closed"


@pytest.mark.parametrize(
    ("mode", "code"),
    [
        ("redirect", "http_error"),
        ("status", "http_error"),
        ("timeout", "timeout"),
        ("connection", "network_error"),
        ("length", "truncated"),
        ("unknown_reason", "truncated"),
        ("body", "invalid_json"),
        ("schema", "schema_error"),
        ("envelope", "invalid_json"),
    ],
)
async def test_vlm_failures(
    mode: str, code: str, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("DEBUG")
    calls = 0

    def handle(request: httpx2.Request) -> httpx2.Response:
        nonlocal calls
        calls += 1
        if mode == "timeout":
            raise httpx2.ReadTimeout("private-detail", request=request)
        if mode == "connection":
            raise httpx2.ConnectError("private-detail", request=request)
        return {
            "redirect": httpx2.Response(302, headers={"location": "https://other.test/leak"}),
            "status": httpx2.Response(500, text="private-detail"),
            "length": reply("length"),
            "unknown_reason": reply("private-detail"),
            "body": reply(content="private-detail"),
            "schema": reply(content="{}"),
            "envelope": httpx2.Response(
                200, headers={"content-type": "application/json"}, text="private-detail"
            ),
        }[mode]

    path = tmp_path / "error.jsonl"
    image = encode_frame(solid(3, 2))
    with JsonlTelemetry(path) as telemetry:
        async with VlmClient(
            CONFIG,
            api_key="private-api-key",
            telemetry=telemetry,
            transport=httpx2.MockTransport(handle),
        ) as client:
            with pytest.raises(VlmError) as error:
                await client.complete_json(
                    system_prompt="private-system",
                    user_text="private-user",
                    image=image,
                    required_keys=frozenset({"state"}),
                )
    assert calls == 1 and error.value.code == code
    log = path.read_text(encoding="utf-8")
    diagnostics = log + str(error.value) + caplog.text
    assert "private-" not in diagnostics and image.base64_data not in diagnostics
    record = json.loads(log)
    status = {"redirect": 302, "status": 500}.get(mode)
    assert error.value.status_code == status
    if status is None:
        assert "status_code" not in record["attrs"]
    else:
        assert str(error.value) == f"VLM HTTP request failed (status={status})"
        assert record["attrs"]["status_code"] == status
    assert (
        record["span"] == "vlm.call" and not record["ok"] and record["attrs"]["error_code"] == code
    )
