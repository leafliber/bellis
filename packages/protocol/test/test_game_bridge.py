"""用锁定给 Runtime 的夹具核对生成的 Python 模型。"""

import json
import math
from pathlib import Path
from types import ModuleType
from typing import NotRequired, TypedDict, cast

import game_bridge
import game_bridge_v2
import pytest
from pydantic import BaseModel, ValidationError

from bellis_sidecar.protocol import RpcNotification, RpcRequest

_HERE = Path(__file__).parent


class _WireCase(TypedDict):
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


def _matches(case: _WireCase, methods: dict[str, _Method], bridge: ModuleType) -> bool:
    if 'rawJson' in case:
        raw = case['rawJson']
    else:
        assert 'message' in case
        raw = json.dumps(case['message'])
    try:
        value: object = bridge.parse_game_bridge_json(raw)
    except ValueError:
        return False
    if not isinstance(value, dict):
        return False
    message = cast('dict[str, object]', value)
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
            payload = bridge.RpcSuccess.model_validate(message).result
            if (
                response_to == 'game.describe'
                and bridge.read_game_bridge_major(payload) != bridge.GAME_BRIDGE_MAJOR
            ):
                return False

        model = getattr(bridge, model_name)
        assert isinstance(model, type) and issubclass(model, BaseModel)
        decoded = model.model_validate(payload)
        assert json.loads(decoded.model_dump_json(by_alias=True, exclude_unset=True)) == payload, (
            case['name']
        )
    except ValidationError:
        return False
    return True


@pytest.mark.parametrize(
    ('fixture', 'schema_name', 'role', 'bridge'),
    [
        ('game-control', 'game-bridge', 'game-runtime.core', game_bridge),
        ('game-main-v2', 'game-bridge-v2', 'game-runtime.main', game_bridge_v2),
    ],
)
def test_fixtures_match_generated_models(
    fixture: str, schema_name: str, role: str, bridge: ModuleType
) -> None:
    fixtures = cast(
        list[_WireCase],
        json.loads((_HERE / 'fixtures' / f'{fixture}.json').read_text(encoding='utf-8')),
    )
    schema = cast(
        _Schema,
        json.loads(
            (_HERE.parent / 'schemas' / f'{schema_name}.schema.json').read_text(encoding='utf-8')
        ),
    )
    methods = schema['x-methods'][role]
    for case in fixtures:
        assert ('message' in case) != ('rawJson' in case), case['name']
        assert _matches(case, methods, bridge) == case['valid'], case['name']


def test_read_major_before_applying_version_specific_model() -> None:
    raw = (
        b'{"jsonrpc":"2.0","id":1,'
        b'"result":{"major":2,"nowMs":1.5,"newField":{"id":7e0,"throughToken":-0}}}'
    )
    envelope = game_bridge.RpcSuccess.model_validate(game_bridge.parse_game_bridge_json(raw))
    assert game_bridge.read_game_bridge_major(envelope.result) == 2

    current = raw.replace(b'"major":2', b'"major":1').replace(
        b'"nowMs":1.5,"newField":{"id":7e0,"throughToken":-0}',
        b'"runtimeId":"run-01","nowMs":1,"newField":true',
    )
    envelope = game_bridge.RpcSuccess.model_validate(game_bridge.parse_game_bridge_json(current))
    assert game_bridge.read_game_bridge_major(envelope.result) == game_bridge.GAME_BRIDGE_MAJOR
    with pytest.raises(ValidationError):
        game_bridge.GameCoreDescription.model_validate(envelope.result)

    for malformed in (
        raw.replace(b'"major":2', b'"major":2.0'),
        raw.replace(b'"id":1', b'"id":1e0'),
    ):
        with pytest.raises(ValueError, match='整数字段'):
            game_bridge.parse_game_bridge_json(malformed)


def test_error_code_has_wire_integer_limits_but_error_data_keeps_numbers() -> None:
    raw = (
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32004,"message":"lease refused",'
        '"data":{"token":7.0,"rank":7e0,"throughToken":-0,"id":9007199254740993}}}'
    )
    failure = game_bridge.RpcFailure.model_validate(game_bridge.parse_game_bridge_json(raw))
    data = cast('dict[str, object]', failure.error.data)
    assert type(data['token']) is float
    assert type(data['rank']) is float
    zero = data['throughToken']
    assert isinstance(zero, float) and math.copysign(1.0, zero) == -1.0
    assert data['id'] == 9007199254740993

    for code in ('-32004.0', '-32004e0', '-0', '9007199254740993'):
        with pytest.raises(ValueError, match='整数字段'):
            game_bridge.parse_game_bridge_json(raw.replace('-32004', code))


@pytest.mark.parametrize('spelling', ['0.7', '7e-1', '-0'])
def test_risk_score_remains_a_json_number(spelling: str) -> None:
    raw = (
        '{"jsonrpc":"2.0","method":"health.reported","params":{"atMs":1,"ready":true,'
        '"mode":"paused","goalId":null,"decisionPointId":null,"prerequisites":[],'
        '"firstActionMs":null,"frameAgeMs":0,"queueDepth":0,"riskScore":RISK,'
        '"riskLimitExceeded":false,"lastRejection":null}}'
    ).replace('RISK', spelling)
    envelope = RpcNotification.model_validate(game_bridge.parse_game_bridge_json(raw))
    health = game_bridge.GameMainHealth.model_validate(envelope.params)
    assert health.riskScore == float(spelling)
    assert math.copysign(1.0, health.riskScore) == math.copysign(1.0, float(spelling))


def test_decoder_rejects_non_json_number_literals() -> None:
    with pytest.raises(ValueError, match='NaN'):
        game_bridge.parse_game_bridge_json('{"riskScore":NaN}')
