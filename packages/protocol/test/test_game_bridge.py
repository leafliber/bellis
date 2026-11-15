"""用锁定给 Runtime 的同一组控制消息核对生成的 Python 模型。"""

import json
from pathlib import Path
from typing import NotRequired, TypedDict, cast

import game_bridge
import pytest
from pydantic import BaseModel, ValidationError

from bellis_sidecar.protocol import RpcNotification, RpcRequest, RpcSuccess

_HERE = Path(__file__).parent


class _ControlCase(TypedDict):
    name: str
    sender: str
    message: NotRequired[dict[str, object]]
    rawJson: NotRequired[str]
    valid: bool
    responseTo: NotRequired[str]


class _Method(TypedDict):
    sender: str
    params: str
    result: str | None


_Schema = TypedDict('_Schema', {'x-methods': dict[str, dict[str, _Method]]})


def _parse_int(raw: str) -> int | float:
    # serde_json 保留负零为浮点。Python 也保留到严格整数校验，避免把 -0 变成有效的 0。
    return -0.0 if raw == '-0' else int(raw)


def _matches(case: _ControlCase, methods: dict[str, _Method]) -> bool:
    if 'rawJson' in case:
        message = cast(dict[str, object], json.loads(case['rawJson'], parse_int=_parse_int))
    else:
        assert 'message' in case
        message = case['message']
    response_to = case.get('responseTo')
    method = response_to if response_to is not None else message.get('method')
    spec = methods.get(method) if isinstance(method, str) else None
    if spec is None:
        return False

    try:
        if response_to is None:
            if case['sender'] != spec['sender']:
                return False
            envelope = RpcNotification if spec['result'] is None else RpcRequest
            envelope.model_validate(message)
            model_name = spec['params']
            payload = message.get('params')
        else:
            model_name = spec['result']
            if model_name is None or case['sender'] == spec['sender']:
                return False
            payload = RpcSuccess.model_validate(message).result

        model = getattr(game_bridge, model_name)
        assert isinstance(model, type) and issubclass(model, BaseModel)
        decoded = model.model_validate(payload)
        assert json.loads(decoded.model_dump_json()) == payload, case['name']
    except ValidationError:
        return False
    return True


def test_control_fixtures_match_generated_models() -> None:
    fixtures = cast(
        list[_ControlCase],
        json.loads((_HERE / 'fixtures' / 'game-control.json').read_text(encoding='utf-8')),
    )
    schema = cast(
        _Schema,
        json.loads(
            (_HERE.parent / 'schemas' / 'game-bridge.schema.json').read_text(encoding='utf-8')
        ),
    )
    methods = schema['x-methods']['game-runtime.core']
    for case in fixtures:
        assert ('message' in case) != ('rawJson' in case), case['name']
        assert _matches(case, methods) == case['valid'], case['name']


def test_read_major_before_applying_version_specific_model() -> None:
    raw = '{"major":2,"nowMs":1.5,"newField":{"id":7e0}}'
    assert game_bridge.GameDescribeVersion.model_validate_json(raw).major == 2
    with pytest.raises(ValidationError):
        game_bridge.GameCoreDescription.model_validate_json(raw)
    with pytest.raises(ValidationError):
        game_bridge.GameDescribeVersion.model_validate_json('{"major":2.0}')
