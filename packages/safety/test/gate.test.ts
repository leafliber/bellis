import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEMORY_WRITE } from '../src/index.ts';
import { flush, request, setup } from './helpers.ts';

test('安全停止中拒绝一切意图，并记录判定', async () => {
  const s = await setup();
  try {
    const decision = await s.safety.authorize(request());
    assert.deepEqual(decision, { allowed: false, reason: '安全停止中，不产生新输出' });
    assert.equal(s.events('intent.denied').length, 1);
  } finally {
    await s.close();
  }
});

test('允许时写入意图与授权事件；同一键重复提交返回已有意图', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const req = request();
    const first = await s.safety.authorize(req);
    assert.ok(first.allowed);
    assert.equal(first.intent.state, 'pending');
    const again = await s.safety.authorize(req);
    assert.ok(again.allowed && again.duplicate);
    assert.equal(s.events('intent.authorized').length, 1);
  } finally {
    await s.close();
  }
});

test('来源没有所需能力、来源未知时拒绝', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const noScene = await s.safety.authorize(request({ capabilities: ['obs.scene'] }));
    assert.deepEqual(noScene, { allowed: false, reason: 'speaker#1 没有能力 obs.scene' });
    const unknown = await s.safety.authorize(request({ holder: 'ghost#9' }));
    assert.deepEqual(unknown, { allowed: false, reason: '未知的意图来源 ghost#9' });
  } finally {
    await s.close();
  }
});

test('Rule of Two：含不可信输入的意图不能申请 OBS 管理能力', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const decision = await s.safety.authorize(
      request({
        holder: 'director#3',
        capabilities: ['obs.scene'],
        source: { origin: 'director', inputs: ['danmaku:1'], untrusted: true },
      }),
    );
    assert.deepEqual(decision, { allowed: false, reason: '含不可信输入的意图不能申请 obs.scene' });
  } finally {
    await s.close();
  }
});

test('守卫只能拒绝或弃权；异常与超时按拒绝处理', async () => {
  const s = await setup({ rateLimits: {} });
  try {
    s.safety.requestMode('M1');
    const abstain = s.safety.addGuard(() => undefined);
    assert.equal((await s.safety.authorize(request())).allowed, true);
    abstain();

    const deny = s.safety.addGuard((r) =>
      (r.payload as { text: string }).text.includes('3') ? { deny: '含 3' } : undefined,
    );
    assert.deepEqual(await s.safety.authorize(request({ payload: { text: '3' } })), {
      allowed: false,
      reason: '含 3',
    });
    deny();

    const crash = s.safety.addGuard(() => {
      throw new Error('依赖缺失');
    });
    assert.deepEqual(await s.safety.authorize(request()), {
      allowed: false,
      reason: '守卫失败：依赖缺失',
    });
    crash();

    s.safety.addGuard(() => new Promise(() => {}));
    const pending = s.safety.authorize(request());
    await flush();
    s.clock.advance(200);
    assert.deepEqual(await pending, { allowed: false, reason: '守卫失败：守卫 未在 200ms 内完成' });
  } finally {
    await s.close();
  }
});

test('守卫判定期间进入安全停止，结果仍为拒绝', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    let release: (() => void) | undefined;
    s.safety.addGuard(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    const pending = s.safety.authorize(request());
    await flush();
    s.safety.requestMode('safe-stop');
    release?.();
    assert.deepEqual(await pending, { allowed: false, reason: '安全停止中，不产生新输出' });
  } finally {
    await s.close();
  }
});

test('目标上有结果未知的意图时隔离该目标', async () => {
  const s = await setup();
  try {
    s.safety.requestMode('M1');
    const decision = await s.safety.authorize(request());
    assert.ok(decision.allowed);
    s.store.start(decision.intent.id);
    s.store.recover();
    assert.deepEqual(await s.safety.authorize(request()), {
      allowed: false,
      reason: '目标 stage 有结果未知的意图，已隔离',
    });
    assert.equal((await s.safety.authorize(request({ target: 'chat' }))).allowed, true);
  } finally {
    await s.close();
  }
});

test('超出速率即拒绝并降级', async () => {
  const s = await setup();
  try {
    s.safety.confirmPresence();
    s.safety.requestMode('M2');
    for (let i = 0; i < 3; i += 1)
      assert.equal((await s.safety.authorize(request())).allowed, true);
    assert.deepEqual(await s.safety.authorize(request()), {
      allowed: false,
      reason: '超出速率：speech.output',
    });
    assert.equal(s.safety.mode, 'M1');
  } finally {
    await s.close();
  }
});

/** 写 Iris 的意图（记忆插件按批申请）：来源含不可信输入，没有时效。 */
const memoryWrite = (overrides: Partial<Parameters<typeof request>[0]> = {}) =>
  request({
    holder: 'memory#4',
    type: MEMORY_WRITE,
    target: 'iris:bellis:test',
    capabilities: [MEMORY_WRITE],
    source: { origin: 'memory', inputs: ['d1'], untrusted: true },
    timeSensitive: false,
    ...overrides,
  });

test('写 Iris（memory.write）是安全停止下的例外：照常判定与授予；其它检查照旧', async () => {
  const s = await setup();
  try {
    assert.equal(s.safety.mode, 'safe-stop');
    const allowed = await s.safety.authorize(memoryWrite());
    assert.ok(allowed.allowed, '安全停止中照常授予');
    // 没有能力照样拒绝；混了别的能力就不是例外。
    assert.deepEqual(await s.safety.authorize(memoryWrite({ holder: 'speaker#1' })), {
      allowed: false,
      reason: 'speaker#1 没有能力 memory.write',
    });
    assert.deepEqual(
      await s.safety.authorize(memoryWrite({ capabilities: [MEMORY_WRITE, 'speech.output'] })),
      { allowed: false, reason: '安全停止中，不产生新输出' },
    );
    // 别的输出照旧拒绝。
    assert.deepEqual(await s.safety.authorize(request()), {
      allowed: false,
      reason: '安全停止中，不产生新输出',
    });
    // 维护态中拒绝（维护态只能从安全停止进入，例外不适用）。
    assert.ok(s.safety.enterMaintenance().ok);
    assert.deepEqual(await s.safety.authorize(memoryWrite()), {
      allowed: false,
      reason: '安全停止中，不产生新输出',
    });
    s.safety.exitMaintenance();
    assert.ok((await s.safety.authorize(memoryWrite())).allowed);
  } finally {
    await s.close();
  }
});

test('写 Iris：状态存储不可用时拒绝', async () => {
  let broken = false;
  const s = await setup(
    {},
    {
      fault: (point) => {
        if (broken && point.endsWith('before-commit')) {
          throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
        }
      },
    },
  );
  try {
    broken = true;
    assert.deepEqual(await s.safety.authorize(memoryWrite()), {
      allowed: false,
      reason: '状态存储不可用',
    });
    broken = false;
    assert.deepEqual(await s.safety.authorize(memoryWrite()), {
      allowed: false,
      reason: '状态存储不可用',
    });
  } finally {
    await s.close();
  }
});

test('状态存储不可用时拒绝新的意图', async () => {
  let broken = false;
  const s = await setup(
    {},
    {
      fault: (point) => {
        if (broken && point.endsWith('before-commit')) {
          throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
        }
      },
    },
  );
  try {
    s.safety.requestMode('M1');
    broken = true;
    assert.deepEqual(await s.safety.authorize(request()), {
      allowed: false,
      reason: '状态存储不可用',
    });
    broken = false;
    assert.deepEqual(await s.safety.authorize(request()), {
      allowed: false,
      reason: '状态存储不可用',
    });
  } finally {
    await s.close();
  }
});
