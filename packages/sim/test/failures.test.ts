import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OBS_EXTERNAL_REASON } from '@bellis/safety';
import {
  FALLBACK_LINE,
  LATE_TEXT,
  type Scenario,
  simulate,
  type TraceEntry,
} from '../src/index.ts';

const base: Scenario = {
  seed: 0,
  moderation: { enabled: false, onError: 'skip', delayMs: 0 },
  ttsSlow: false,
  danmaku: [],
  outputs: [],
  announcements: [],
  operator: [],
  durationMs: 20_000,
};

/** 三条弹幕各触发一次调用：超时（晚到的输出不理会中止）、出错、非法输出。 */
const failing: Scenario = {
  ...base,
  danmaku: [
    { atMs: 0, viewer: 0, nickname: 0, text: 0 },
    { atMs: 3000, viewer: 1, nickname: 1, text: 1 },
    { atMs: 6000, viewer: 2, nickname: 2, text: 0 },
  ],
  outputs: [
    { kind: 'timeout', ignoreAbort: true },
    { kind: 'error', error: 'server' },
    { kind: 'invalid' },
  ],
};

const kinds = (trace: readonly TraceEntry[], kind: string) => trace.filter((e) => e.kind === kind);
const modes = (trace: readonly TraceEntry[]) =>
  kinds(trace, 'control.mode').map((e) => String(e.data.mode));

for (const mode of ['M0', 'M2'] as const) {
  test(`模型连续失败（${mode}）：失败不发言，晚到的输出不播，过渡语只一句；第三次告警并请求降级，模式只降不升`, async () => {
    const result = await simulate({ ...failing, mode });
    assert.deepEqual(result.violations, []);
    const { trace } = result.history;

    // 超时：截止时间先到，晚到的输出照样给出，但没有交给发声。
    const aborted = kinds(trace, 'llm.aborted');
    assert.deepEqual(
      aborted.map((e) => e.data),
      [{ call: 0, deadline: true }],
    );
    const late = kinds(trace, 'llm.output').find((e) => e.data.call === 0);
    assert.ok(late && late.seq > (aborted[0]?.seq ?? 0), '晚到的输出在截止之后');
    const requested = kinds(trace, 'speech.requested');
    assert.ok(!requested.some((e) => String(e.data.text).includes(LATE_TEXT)));
    // 这一串失败只请求了一句过渡语（第一次超时时有观众在等），没有别的发言。
    assert.deepEqual(
      requested.filter((e) => String(e.data.id).startsWith('director:')).map((e) => e.data.text),
      [FALLBACK_LINE],
    );

    const alarms = kinds(trace, 'fact.director.alarmed');
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0]?.data.cause, 'failures');
    assert.equal(alarms[0]?.data.count, 3);
    const downgrade = kinds(trace, 'fact.safety.downgrade-requested');
    assert.equal(downgrade.length, 1);
    assert.equal(downgrade[0]?.data.mode, mode);
    // M0 与 M1 降级进入安全停止；M2 在场确认有效时降到 M1。之后没有人升级，模式不再上升。
    const expected = mode === 'M2' ? 'M1' : 'safe-stop';
    assert.deepEqual(modes(trace), [mode, expected]);
  });
}

test('真实输出模式下 OBS 外部切到安全场景：急停，直到操作员重新升级 Stage 不再播出', async () => {
  const result = await simulate({
    ...base,
    mode: 'M2',
    danmaku: [{ atMs: 0, viewer: 1, nickname: 1, text: 1 }],
    outputs: [{ kind: 'reply', sentences: [1, 4, 5], target: 1 }],
    announcements: [{ atMs: 9000, sentences: [0], immediate: false }],
    operator: [
      { atMs: 1000, action: 'obs-scene' },
      { atMs: 1500, action: 'obs-mute' },
      { atMs: 8000, action: 'upgrade' },
    ],
  });
  assert.deepEqual(result.violations, []);
  const { trace } = result.history;
  assert.deepEqual(
    kinds(trace, 'fact.safety.obs-external').map((e) => e.data),
    [{ change: 'scene', scene: 'Safe', resync: false, mode: 'M2' }],
  );
  const stop = kinds(trace, 'control.stop');
  assert.deepEqual(
    stop.map((e) => e.data.reason),
    [OBS_EXTERNAL_REASON.scene],
  );
  // 急停时应急动作已经静音：随后的外部静音没有改变 OBS，什么也不发生。
  const actions = kinds(trace, 'operator.action').map((e) => e.data);
  assert.deepEqual(actions, [
    { action: 'obs-scene', changed: true },
    { action: 'obs-mute', changed: false },
    { action: 'upgrade' },
  ]);
  assert.deepEqual(modes(trace), ['M2', 'safe-stop', 'M2']);
  // 回应在句中被截断，只写回已播出的部分；升级之前没有采样播出，升级之后定时播报照常播出。
  const reply = kinds(trace, 'fact.utterance').find((e) => e.data.source === 'danmaku-reply');
  assert.equal(reply?.data.end, 'stopped');
  const stoppedAt = stop[0]?.seq ?? 0;
  const upgradedAt = kinds(trace, 'control.mode').at(-1)?.seq ?? 0;
  assert.ok(
    !kinds(trace, 'page.played').some((e) => e.seq > stoppedAt && e.seq < upgradedAt),
    '安全停止期间没有采样播出',
  );
  assert.ok(kinds(trace, 'page.played').some((e) => e.seq > upgradedAt));
});

test('M0 下 OBS 外部静音 Stage 源：只写日志，不急停，发言照常播完', async () => {
  const result = await simulate({
    ...base,
    danmaku: [{ atMs: 0, viewer: 1, nickname: 1, text: 1 }],
    outputs: [{ kind: 'reply', sentences: [1, 4], target: 1 }],
    operator: [{ atMs: 1000, action: 'obs-mute' }],
  });
  assert.deepEqual(result.violations, []);
  const { trace } = result.history;
  assert.deepEqual(kinds(trace, 'fact.safety.obs-external'), []);
  assert.deepEqual(kinds(trace, 'control.stop'), []);
  assert.deepEqual(
    kinds(trace, 'log.safety.obs-external-ignored').map((e) => e.data),
    [{ change: 'mute', input: 'Stage', resync: false, mode: 'M0', maintenance: false }],
  );
  assert.deepEqual(modes(trace), ['M0']);
  const reply = kinds(trace, 'fact.utterance').find((e) => e.data.source === 'danmaku-reply');
  assert.equal(reply?.data.end, 'complete');
});
