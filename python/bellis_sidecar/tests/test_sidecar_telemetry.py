import json
import re
import shutil
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from bellis_sidecar.protocol import SidecarTelemetry
from bellis_sidecar.telemetry import (
    ENV_ROLE,
    ENV_TELEMETRY,
    NOOP_TELEMETRY,
    TraceContext,
    attribute_allowed,
    encode_value,
    file_stamp,
    filter_attributes,
    format_traceparent,
    parse_traceparent,
    telemetry_from_env,
)


@pytest.fixture
def workdir() -> Iterator[Path]:
    # 不用 pytest 的 tmp_path：它在 Windows 上要建共享的 pytest-of-<用户> 目录，受本机权限影响。
    path = Path(tempfile.mkdtemp(prefix='bellis-telemetry-'))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
ROLE = 'sidecar.tts-local'


def env(directory: Path, **overrides: int) -> dict[str, str]:
    config = SidecarTelemetry(
        v=1,
        dir=str(directory),
        maxFileBytes=overrides.get('maxFileBytes', 1_000_000),
        maxFileAgeMs=overrides.get('maxFileAgeMs', 3_600_000),
        maxFiles=overrides.get('maxFiles', 5),
        maxQueue=overrides.get('maxQueue', 100),
        flushIntervalMs=overrides.get('flushIntervalMs', 20),
    )
    return {ENV_TELEMETRY: config.model_dump_json(), ENV_ROLE: ROLE}


def read_spans(directory: Path) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    for path in sorted(directory.glob('*.jsonl')):
        for line in path.read_text(encoding='utf-8').splitlines():
            request = json.loads(line)
            for resource in request['resourceSpans']:
                for scoped in resource['scopeSpans']:
                    spans.extend(scoped['spans'])
    return spans


def test_traceparent_round_trip_and_rejects_bad_input():
    context = parse_traceparent(VALID)
    assert context is not None
    assert context == TraceContext('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7', True)
    assert format_traceparent(context) == VALID
    assert parse_traceparent(f'cc{VALID[2:]}-future') is not None
    for bad in [
        None,
        42,
        '',
        f'{VALID}-extra',
        f'ff{VALID[2:]}',
        f'00-{"0" * 32}-00f067aa0ba902b7-01',
        f'00-4bf92f3577b34da6a3ce929d0e0e4736-{"0" * 16}-01',
        VALID.upper(),
        f'cc{VALID[2:]}x',
        f' {VALID}',
    ]:
        assert parse_traceparent(bad) is None, bad


def test_attribute_rules_match_the_host():
    for ok in ['bellis.tts.backend', 'gen_ai.request.model', 'error.type']:
        assert attribute_allowed(ok), ok
    for bad in [
        'bellis.tts.text',
        'bellis.danmaku.nickname',
        'bellis.viewer.id',
        'gen_ai.input.messages',
        'gen_ai.system_instructions',
        'service.name',
        'Bellis.X',
    ]:
        assert not attribute_allowed(bad), bad
    assert encode_value(True) == {'boolValue': True}
    assert encode_value(3) == {'intValue': '3'}
    assert encode_value(0.5) == {'doubleValue': 0.5}
    assert encode_value('qwen3') == {'stringValue': 'qwen3'}
    for bad_value in [float('nan'), '你好', 'x' * 129, 2**63, [1], None]:
        assert encode_value(bad_value) is None, bad_value
    accepted, dropped = filter_attributes(
        {'bellis.tts.chars': 5, 'bellis.tts.text': '你好', 'bellis.tts.note': '中文', 'x': None}
    )
    assert accepted == {'bellis.tts.chars': {'intValue': '5'}}
    assert dropped == 2


def test_without_or_with_bad_environment_telemetry_is_a_noop(workdir: Path):
    assert telemetry_from_env({}, scope='t') is NOOP_TELEMETRY
    assert (
        telemetry_from_env({ENV_TELEMETRY: '{"v":2}', ENV_ROLE: ROLE}, scope='t') is NOOP_TELEMETRY
    )
    assert telemetry_from_env({**env(workdir), ENV_ROLE: ''}, scope='t') is NOOP_TELEMETRY
    span = NOOP_TELEMETRY.start_span('x', parent=VALID)
    assert span.traceparent is None
    span.set_attributes({'bellis.a': 1})
    span.add_event('e')
    span.fail('boom')
    span.end()
    assert list(workdir.iterdir()) == []


def test_spans_join_the_hosts_trace_and_are_written_as_otlp_json(workdir: Path):
    telemetry = telemetry_from_env(env(workdir), scope='tts_local')
    span = telemetry.start_span(
        'tts_local.synthesize',
        parent=VALID,
        kind='server',
        attributes={'bellis.tts.chars': 2, 'bellis.tts.text': '你好'},
    )
    child = telemetry.start_span('tts_local.align', parent=span.traceparent)
    child.fail('RuntimeError')
    child.end()
    span.add_event('bellis.tts.first_chunk')
    span.end()
    root = telemetry.start_span('orphan', parent='garbage')
    root.end()
    telemetry.close()

    files = list(workdir.iterdir())
    assert len(files) == 1
    assert re.fullmatch(r'sidecar\.tts-local-\d{8}T\d{9}Z-0\.jsonl', files[0].name)
    line = json.loads(files[0].read_text(encoding='utf-8').splitlines()[0])
    resource = {a['key']: a['value'] for a in line['resourceSpans'][0]['resource']['attributes']}
    assert resource['service.name'] == {'stringValue': 'bellis.sidecar.tts-local'}
    assert resource['telemetry.sdk.language'] == {'stringValue': 'python'}
    assert line['resourceSpans'][0]['scopeSpans'][0]['scope'] == {'name': 'tts_local'}

    align, synthesize, orphan = read_spans(workdir)
    assert synthesize['traceId'] == '4bf92f3577b34da6a3ce929d0e0e4736'
    assert synthesize['parentSpanId'] == '00f067aa0ba902b7'
    assert synthesize['kind'] == 2
    assert synthesize['attributes'] == [{'key': 'bellis.tts.chars', 'value': {'intValue': '2'}}]
    assert synthesize['droppedAttributesCount'] == 1
    assert synthesize['status'] == {'code': 0}
    assert [e['name'] for e in synthesize['events']] == ['bellis.tts.first_chunk']
    assert int(synthesize['endTimeUnixNano']) >= int(synthesize['startTimeUnixNano'])
    assert align['traceId'] == synthesize['traceId']
    assert align['parentSpanId'] == synthesize['spanId']
    assert align['status'] == {'code': 2}
    assert align['attributes'] == [{'key': 'error.type', 'value': {'stringValue': 'RuntimeError'}}]
    assert 'parentSpanId' not in orphan
    assert re.fullmatch(r'[0-9a-f]{32}', orphan['traceId'])
    assert re.fullmatch(r'[0-9a-f]{16}', orphan['spanId'])


def test_rotation_and_retention_per_role(workdir: Path):
    other = workdir / 'host-20261021T000000000Z-0.jsonl'
    other.write_text('host\n', encoding='utf-8')
    telemetry = telemetry_from_env(
        env(workdir, maxFileBytes=65_536, maxFiles=2, flushIntervalMs=10), scope='t'
    )
    for batch in range(4):
        for _ in range(150):
            telemetry.start_span(f'span-{batch}', attributes={'bellis.pad': 'x' * 120}).end()
        time.sleep(0.15)
    telemetry.close()
    own = sorted(p.name for p in workdir.glob('sidecar.tts-local-*.jsonl'))
    assert len(own) == 2
    assert other.exists()
    assert all(p.stat().st_size <= 65_536 * 2 for p in workdir.glob('sidecar.*.jsonl'))


def test_write_failure_and_full_queue_never_raise(workdir: Path):
    blocked = workdir / 'blocked'
    blocked.write_text('不是目录', encoding='utf-8')
    telemetry = telemetry_from_env(env(blocked), scope='t')
    telemetry.start_span('lost').end()
    telemetry.close()
    exporter: Any = getattr(telemetry, 'exporter')  # noqa: B009
    assert exporter.write_failures == 1
    assert exporter.lost == 1

    full = telemetry_from_env(env(workdir / 'full', maxQueue=3, flushIntervalMs=60_000), scope='t')
    for index in range(5):
        full.start_span(f's{index}').end()
    full.close()
    assert [s['name'] for s in read_spans(workdir / 'full')] == ['s2', 's3', 's4']
    assert getattr(full, 'exporter').dropped == 2  # noqa: B009


def test_file_stamp_is_utc_and_sortable():
    assert file_stamp(1_792_577_700_123) == '20261021T101500123Z'
