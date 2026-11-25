"""A single-request, JSON-only vision client with redacted errors and telemetry."""

import json
import math
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from time import perf_counter
from typing import Self, cast

import httpx2
import openai
from bellis_common import cred
from bellis_common.telemetry import JsonlTelemetry
from openai.types.chat import ChatCompletion, ChatCompletionContentPartParam

from .frame import EncodedFrame
from .profile import ProfileError, VlmProfileConfig, checked_base_url, timeout_seconds


class VlmError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int | None = None,
        schema_issue: str | None = None,
    ) -> None:
        self.code = code
        self.status_code = status_code
        self.schema_issue = schema_issue
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class VlmConfig:
    base_url: str
    model: str
    timeout_s: float = 30.0
    max_tokens: int = 4096
    reasoning_effort: str | None = "low"
    response_format_json: bool = True
    cred_targets: tuple[str, ...] = ("ark.bellis", "ark.bellis-game-runtime")
    api_key_env: str = "BELLIS_VLM_API_KEY"

    def __post_init__(self) -> None:
        try:
            checked_base_url(self.base_url)
            timeout_seconds(self.timeout_s)
        except ProfileError:
            raise VlmError("invalid_config", "Invalid VLM URL or timeout") from None
        if type(self.model) is not str or not self.model.strip():
            raise VlmError("invalid_config", "Invalid VLM model")
        if type(self.max_tokens) is not int or self.max_tokens < 1:
            raise VlmError("invalid_config", "Invalid VLM token limit")

    @classmethod
    def from_profile(cls, profile_vlm: VlmProfileConfig) -> Self:
        return cls(
            profile_vlm.base_url, profile_vlm.model, timeout_s=profile_vlm.timeout_s,
            reasoning_effort=profile_vlm.reasoning_effort, cred_targets=profile_vlm.cred_targets,
        )  # fmt: skip


def resolve_vlm_api_key(
    config: VlmConfig,
    *,
    explicit_key: str | None = None,
    env: Mapping[str, str] | None = None,
    cred_reader: Callable[[str], str | None] | None = None,
) -> str:
    if key := (explicit_key or "").strip():
        return key
    source = os.environ if env is None else env
    if key := source.get(config.api_key_env, "").strip():
        return key
    reader = cred.read_secret_text if cred_reader is None else cred_reader
    for target in config.cred_targets:
        try:
            if key := (reader(target) or "").strip():
                return key
        except cred.CredError:
            continue
    raise VlmError("missing_credentials", "No VLM credential found")


@dataclass(frozen=True, slots=True)
class VlmUsage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


@dataclass(frozen=True, slots=True)
class VlmJsonResult:
    data: dict[str, object]
    raw_text: str
    model: str
    finish_reason: str | None
    dur_ms: float
    usage: VlmUsage | None


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    obj = dict(pairs)
    if len(obj) != len(pairs):
        raise ValueError("duplicate key")
    return obj


def _finite(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    return value


def parse_strict_json_object(
    text: str,
    *,
    required_keys: frozenset[str] = frozenset(),
    allowed_keys: frozenset[str] | None = None,
) -> dict[str, object]:
    text = text.strip()
    fence = re.fullmatch(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", text, re.DOTALL | re.IGNORECASE)
    try:
        obj: object = json.loads(
            fence[1] if fence else text,
            object_pairs_hook=_unique_object,
            parse_constant=_finite,
            parse_float=_finite,
        )
    except (ValueError, RecursionError):
        raise VlmError("invalid_json", "Invalid JSON response") from None
    if not isinstance(obj, dict):
        raise VlmError("schema_error", "Expected a JSON object", schema_issue="not_object")
    data = cast("dict[str, object]", obj)
    if required_keys - data.keys():
        raise VlmError(
            "schema_error", "Missing required response fields", schema_issue="missing_required"
        )
    if allowed_keys is not None and data.keys() - allowed_keys:
        raise VlmError("schema_error", "Unexpected response fields", schema_issue="unexpected_keys")
    return data


class VlmClient:
    def __init__(
        self,
        config: VlmConfig,
        *,
        api_key: str | None = None,
        transport: httpx2.AsyncBaseTransport | None = None,
        telemetry: JsonlTelemetry | None = None,
    ) -> None:
        key = resolve_vlm_api_key(config, explicit_key=api_key)
        self._config = config
        self._telemetry = telemetry
        timeout = config.timeout_s
        http = httpx2.AsyncClient(follow_redirects=False, timeout=timeout, transport=transport)
        self._client = openai.AsyncOpenAI(
            api_key=key, base_url=config.base_url, http_client=http, timeout=timeout, max_retries=0
        )

    async def _request(
        self, system_prompt: str, user_text: str, image: EncodedFrame
    ) -> ChatCompletion:
        cfg = self._config
        content: list[ChatCompletionContentPartParam] = [
            {"type": "text", "text": user_text},
            {"type": "image_url", "image_url": {"url": image.data_url}},
        ]
        extra = {"reasoning_effort": cfg.reasoning_effort} if cfg.reasoning_effort else None
        try:
            return await self._client.chat.completions.create(
                model=cfg.model,
                max_tokens=cfg.max_tokens,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": content},
                ],
                response_format={"type": "json_object"}
                if cfg.response_format_json
                else openai.omit,
                extra_body=extra,
            )
        except (openai.APITimeoutError, httpx2.TimeoutException):
            raise VlmError("timeout", "VLM request timed out") from None
        except (openai.APIStatusError, httpx2.HTTPStatusError) as exc:
            status = (
                exc.status_code
                if isinstance(exc, openai.APIStatusError)
                else exc.response.status_code
            )
            raise VlmError(
                "http_error", f"VLM HTTP request failed (status={status})", status_code=status
            ) from None
        except (openai.APIConnectionError, httpx2.RequestError):
            raise VlmError("network_error", "VLM connection failed") from None
        except (ValueError, openai.APIResponseValidationError):
            raise VlmError("invalid_json", "Invalid VLM response envelope") from None

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_text: str,
        image: EncodedFrame,
        required_keys: frozenset[str] = frozenset(),
        allowed_keys: frozenset[str] | None = None,
        trace_id: str | None = None,
    ) -> VlmJsonResult:
        start = perf_counter()
        attrs: dict[str, object] = {"model": self._config.model}
        result = None
        try:
            if self._client.is_closed():
                raise VlmError("closed", "VLM client is closed")
            response = await self._request(system_prompt, user_text, image)
            choice = response.choices[0]
            reason = choice.finish_reason
            # Only known protocol values may enter telemetry from the response.
            reasons = (None, "stop", "length", "tool_calls", "function_call", "content_filter")
            attrs["finish_reason"] = reason if reason in reasons else "unknown"
            if reason not in (None, "stop"):
                raise VlmError("truncated", "Incomplete VLM response")
            usage = None
            if (u := response.usage) is not None:
                counts = (u.prompt_tokens, u.completion_tokens, u.total_tokens)
                if not all(type(n) is int and n >= 0 for n in counts):
                    raise VlmError("schema_error", "Invalid VLM token counts")
                usage = VlmUsage(*counts)
                attrs.update(prompt_tokens=u.prompt_tokens, completion_tokens=u.completion_tokens)
            raw = choice.message.content
            if not isinstance(raw, str) or type(response.model) is not str:
                raise VlmError("schema_error", "Missing VLM text or model")
            data = parse_strict_json_object(
                raw, required_keys=required_keys, allowed_keys=allowed_keys
            )
            result = VlmJsonResult(
                data, raw, response.model, reason, (perf_counter() - start) * 1000, usage
            )
            return result
        except VlmError as exc:
            attrs["error_code"] = exc.code
            if exc.code == "schema_error":
                attrs["schema_issue"] = exc.schema_issue or "bad_envelope"
            if exc.status_code is not None:
                attrs["status_code"] = exc.status_code
            raise
        except (AttributeError, TypeError, KeyError, IndexError):
            attrs.update(error_code="schema_error", schema_issue="bad_envelope")
            raise VlmError("schema_error", "Malformed VLM completion") from None
        finally:
            if self._telemetry is not None:
                ok = result is not None
                duration = result.dur_ms if result is not None else (perf_counter() - start) * 1000
                self._telemetry.record(
                    "vlm.call", dur_ms=duration, ok=ok, trace_id=trace_id, attrs=attrs
                )

    async def close(self) -> None:
        await self._client.close()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()
