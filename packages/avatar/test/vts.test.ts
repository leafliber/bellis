import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Clock } from '@bellis/kernel';
import type { FromPage } from '@bellis/stage';
import type { Intent } from '@bellis/store';
import { AVATAR_EXPRESSION, VTS_PLUGIN_DEVELOPER, VTS_PLUGIN_NAME } from '../src/index.ts';
import { FakeVts } from './fake-vts.ts';
import { freePort, setup, until } from './helpers.ts';

const types = (vts: FakeVts) => vts.received.map((r) => r.messageType);

test('首次连接：没有令牌时申请，维护者允许后写入凭据服务再认证；令牌不进日志与事件', async () => {
  const vts = await FakeVts.start({ approval: 'tok-first-0123' });
  const s = await setup({ url: vts.url });
  try {
    assert.equal(s.state(), 'active');
    await until(() => s.avatar().ready);
    assert.equal(s.avatar().status, '就绪');
    assert.equal(await s.secrets.get('vts'), 'tok-first-0123');
    assert.deepEqual(types(vts).slice(0, 2), [
      'AuthenticationTokenRequest',
      'AuthenticationRequest',
    ]);
    assert.deepEqual(vts.of('AuthenticationTokenRequest')[0], {
      pluginName: VTS_PLUGIN_NAME,
      pluginDeveloper: VTS_PLUGIN_DEVELOPER,
    });
    assert.equal(vts.of('AuthenticationRequest')[0]?.authenticationToken, 'tok-first-0123');
    assert.ok(s.logged('avatar.token-saved').length === 1);
    assert.ok(!JSON.stringify(s.logs).includes('tok-first-0123'));
    assert.ok(!JSON.stringify(s.store.events()).includes('tok-first-0123'));
  } finally {
    await s.close();
    await vts.close();
  }
});

test('已存令牌有效：直接认证，不再弹窗', async () => {
  const vts = await FakeVts.start({ tokens: ['tok-saved'], approval: 'hold' });
  const s = await setup({ url: vts.url, token: 'tok-saved' });
  try {
    await until(() => s.avatar().ready);
    assert.equal(vts.of('AuthenticationTokenRequest').length, 0);
    assert.equal(vts.of('AuthenticationRequest')[0]?.authenticationToken, 'tok-saved');
  } finally {
    await s.close();
    await vts.close();
  }
});

test('已存令牌被 VTS 拒绝：重新申请，新令牌写回后认证', async () => {
  const vts = await FakeVts.start({ approval: 'tok-new' });
  const s = await setup({ url: vts.url, token: 'tok-revoked' });
  try {
    await until(() => s.avatar().ready);
    assert.deepEqual(types(vts).slice(0, 3), [
      'AuthenticationRequest',
      'AuthenticationTokenRequest',
      'AuthenticationRequest',
    ]);
    assert.equal(await s.secrets.get('vts'), 'tok-new');
    assert.equal(s.logged('avatar.token-rejected').length, 1);
    assert.ok(!JSON.stringify(s.logs).includes('tok-revoked'));
  } finally {
    await s.close();
    await vts.close();
  }
});

test('等待弹窗时报告未就绪；维护者拒绝后不再申请，插件保持激活', async () => {
  const vts = await FakeVts.start({ approval: 'hold' });
  try {
    const s = await setup({ url: vts.url });
    try {
      await until(() => vts.of('AuthenticationTokenRequest').length === 1);
      assert.equal(s.avatar().ready, false);
      assert.equal(s.avatar().status, '等待维护者在 VTube Studio 中允许插件');
    } finally {
      await s.close();
    }

    vts.approval = 'deny';
    const again = await setup({ url: vts.url });
    try {
      await until(() => again.logged('avatar.token-denied').length === 1);
      await again.run(3000);
      assert.equal(again.state(), 'active');
      assert.equal(again.avatar().ready, false);
      assert.match(again.avatar().status, /拒绝了插件/);
      assert.equal(vts.of('AuthenticationTokenRequest').length, 2);
      assert.equal(await again.secrets.get('vts'), undefined);
    } finally {
      await again.close();
    }
  } finally {
    await vts.close();
  }
});

/** 测试用包络：采样率 1000（每毫秒一个采样），每 10 个采样一个窗口；映射后第 i 个窗口恰为 i/100。 */
const RAMP = {
  sampleRate: 1000,
  window: 10,
  rms: Array.from({ length: 100 }, (_, i) => 0.1 + i * 0.004),
};

test('按游标与包络注入口型：频率、外推上限、欠载闭嘴、句子结束归零', async () => {
  const vts = await FakeVts.start({ tokens: ['t'] });
  const s = await setup({
    url: vts.url,
    token: 't',
    config: { rateHz: 50, rmsFloor: 0.1, rmsCeiling: 0.5, extrapolateMaxMs: 200 },
  });
  try {
    await until(() => s.avatar().ready);
    s.stage.envelopes.set('s1', RAMP);
    // 每个时刻先注入（用到此刻之前的游标），再发生该时刻的事件。
    const events = new Map<number, FromPage>([
      [0, { kind: 'started', sentenceId: 's1' }],
      [100, { kind: 'cursor', sentenceId: 's1', played: 90 }],
      [400, { kind: 'underrun', sentenceId: 's1', played: 290 }],
      [420, { kind: 'cursor', sentenceId: 's1', played: 290 }],
      [440, { kind: 'cursor', sentenceId: 's1', played: 300 }],
      [600, { kind: 'ended', sentenceId: 's1', played: 460 }],
    ]);
    for (let t = 0; t <= 1000; t += 20) {
      if (t > 0) await s.run(20, 20);
      const event = events.get(t);
      if (event) s.stage.emit(event);
    }
    await until(() => vts.injections().length === 51);
    const expected = (t: number) => {
      if (t === 0 || (t > 400 && t <= 440) || t > 600) return 0;
      if (t <= 100) return t / 1000;
      if (t <= 400) return (90 + Math.min(t - 100, 200)) / 1000;
      return (300 + (t - 440)) / 1000;
    };
    const injections = vts.injections();
    injections.forEach((injection, k) => {
      assert.equal(injection.id, 'MouthOpen');
      assert.equal(injection.faceFound, true);
      assert.equal(injection.mode, 'set');
      const want = expected(k * 20);
      assert.ok(
        Math.abs((injection.value as number) - want) < 1e-9,
        `t=${k * 20} 期望 ${want}，实际 ${injection.value}`,
      );
    });
    // 外推到上限后保持不动：t=300 起直到欠载都是 0.29。
    assert.equal(expected(300), expected(400));
    await s.run(100);
    assert.equal(vts.injections().length, 51 + 5);
  } finally {
    await s.close();
    await vts.close();
  }
});

test('口型推迟（呈现延迟 − k_mouth）：呈现延迟 100ms、k_mouth 40ms 时取 60ms 之前的位置，播完也晚 60ms 闭嘴', async () => {
  const vts = await FakeVts.start({ tokens: ['t'] });
  const s = await setup({
    url: vts.url,
    token: 't',
    config: { rateHz: 50, rmsFloor: 0.1, rmsCeiling: 0.5, extrapolateMaxMs: 200, kMouthMs: 40 },
  });
  try {
    await until(() => s.avatar().ready);
    s.stage.envelopes.set('s1', RAMP);
    s.stage.setPresentation({ delayMs: 100, samples: 21, source: 'meters' });
    const events = new Map<number, FromPage>([
      [0, { kind: 'started', sentenceId: 's1' }],
      [200, { kind: 'cursor', sentenceId: 's1', played: 200 }],
      [400, { kind: 'ended', sentenceId: 's1', played: 400 }],
    ]);
    for (let t = 0; t <= 600; t += 20) {
      if (t > 0) await s.run(20, 20);
      const event = events.get(t);
      if (event) s.stage.emit(event);
      // 播完后 Stage 不再提供包络：推迟的那 60ms 用形象开始时留下的。
      if (t === 400) s.stage.envelopes.delete('s1');
    }
    await until(() => vts.injections().length === 31);
    const expected = (t: number) => (t <= 60 || t >= 460 ? 0 : (t - 60) / 1000);
    vts.injections().forEach((injection, k) => {
      const want = expected(k * 20);
      assert.ok(
        Math.abs((injection.value as number) - want) < 1e-9,
        `t=${k * 20} 期望 ${want}，实际 ${injection.value}`,
      );
    });
  } finally {
    await s.close();
    await vts.close();
  }
});

test('不说话时照常以配置的频率注入 0，任一秒内都有重发', async () => {
  let clock: Clock | undefined;
  const vts = await FakeVts.start({ tokens: ['t'], now: () => clock?.now() ?? 0 });
  const s = await setup({ url: vts.url, token: 't' });
  clock = s.clock;
  try {
    await until(() => s.avatar().ready);
    await s.run(3000);
    await until(() => vts.injections().length >= 90);
    const injections = vts.injections();
    // 30Hz：3 秒内 90 次左右（周期不是整毫秒，允许差一次）。
    assert.ok(injections.length >= 90 && injections.length <= 92, `${injections.length}`);
    assert.ok(injections.every((i) => i.value === 0 && i.faceFound === true && i.mode === 'set'));
    for (let second = 0; second < 3; second += 1) {
      const within = injections.filter((i) => i.at > second * 1000 && i.at <= (second + 1) * 1000);
      assert.ok(within.length >= 25, `第 ${second + 1} 秒只有 ${within.length} 次`);
    }
  } finally {
    await s.close();
    await vts.close();
  }
});

test('参数已被其他插件占用：记录事实并报告未就绪，不再注入、不抢写', async () => {
  const vts = await FakeVts.start({ tokens: ['t'], occupied: ['MouthOpen'] });
  const s = await setup({ url: vts.url, token: 't' });
  try {
    await until(() => s.logged('avatar.injection-stopped').length === 1);
    const facts = s.store.events().filter((e) => e.type === 'avatar.injection-stopped');
    assert.equal(facts.length, 1);
    assert.equal((facts[0]?.data as { parameter?: string } | undefined)?.parameter, 'MouthOpen');
    assert.equal(s.avatar().ready, false);
    assert.equal(s.avatar().status, '参数 MouthOpen 已被其他插件占用');
    const sent = vts.injections().length;
    await s.run(2000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(vts.injections().length, sent);
    assert.equal(s.state(), 'active');
  } finally {
    await s.close();
    await vts.close();
  }
});

test('断线后按固定间隔重连，用已存令牌重新认证并恢复注入', async () => {
  const vts = await FakeVts.start({ tokens: ['t'] });
  const s = await setup({ url: vts.url, token: 't' });
  try {
    await until(() => s.avatar().ready);
    vts.drop();
    await until(() => !s.avatar().ready);
    assert.equal(s.avatar().status, '未连接 VTube Studio');
    assert.equal(s.logged('avatar.disconnected').length, 1);
    // 重连间隔是 500ms（见 setup），到点之前不重连。
    await s.run(400);
    assert.equal(vts.accepted, 1);
    await s.run(200);
    await until(() => s.avatar().ready);
    assert.equal(vts.accepted, 2);
    assert.equal(vts.of('AuthenticationTokenRequest').length, 0);
    const sent = vts.injections().length;
    await s.run(200);
    await until(() => vts.injections().length >= sent + 6);
  } finally {
    await s.close();
    await vts.close();
  }
});

test('VTS 不在：插件保持激活、报告未就绪；VTS 起来后自动连上', async () => {
  const port = await freePort();
  const s = await setup({ url: `ws://127.0.0.1:${port}`, token: 't' });
  let vts: FakeVts | undefined;
  try {
    await until(() => s.logged('avatar.connect-failed').length === 1);
    assert.equal(s.state(), 'active');
    assert.equal(s.avatar().ready, false);
    assert.match(s.avatar().status, /^未连接 VTube Studio/);
    vts = await FakeVts.start({ port, tokens: ['t'] });
    await s.run(600);
    await until(() => s.avatar().ready);
  } finally {
    await s.close();
    await vts?.close();
  }
});

test('表情：已授权的意图经热键触发；未申请能力、未配置、VTS 拒绝、安全停止下都不触发', async () => {
  const vts = await FakeVts.start({ tokens: ['t'], hotkeys: ['hk-smile'] });
  const s = await setup({
    url: vts.url,
    token: 't',
    config: { expressions: { smile: 'hk-smile', frown: 'hk-gone' } },
  });
  const authorized = async (name: string, capabilities = [AVATAR_EXPRESSION]): Promise<Intent> => {
    const decision = await s.authorize({ expression: name }, capabilities);
    assert.ok(decision.allowed, decision.allowed ? '' : decision.reason);
    return decision.intent;
  };
  try {
    await until(() => s.avatar().ready);
    // 安全停止下闸门不授权。
    assert.equal((await s.authorize({ expression: 'smile' }, [AVATAR_EXPRESSION])).allowed, false);
    assert.ok(s.core.requestMode('M1').ok);

    const done = await s.avatar().expression(await authorized('smile'), 'smile');
    assert.equal(done.state, 'succeeded');
    assert.deepEqual(vts.of('HotkeyTriggerRequest'), [{ hotkeyID: 'hk-smile' }]);

    const without = await s.avatar().expression(await authorized('smile', []), 'smile');
    assert.equal(without.state, 'failed');
    assert.match(without.error ?? '', /没有申请 avatar\.expression/);

    const unknown = await s.avatar().expression(await authorized('cry'), 'cry');
    assert.match(unknown.error ?? '', /没有配置表情 cry/);

    const refused = await s.avatar().expression(await authorized('frown'), 'frown');
    assert.match(refused.error ?? '', /拒绝触发热键 hk-gone：202/);

    await assert.rejects(
      s.avatar().expression(await authorized('smile'), 'frown'),
      /载荷与授权时不一致/,
    );

    // 授权之后进入安全停止：执行前再核对，不触发。
    const late = await authorized('smile');
    await s.core.emergencyStop('测试');
    const stopped = await s.avatar().expression(late, 'smile');
    assert.equal(stopped.state, 'failed');
    assert.match(stopped.error ?? '', /安全停止中/);
    assert.equal(vts.of('HotkeyTriggerRequest').length, 2);
  } finally {
    await s.close();
    await vts.close();
  }
});
