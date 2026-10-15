import assert from 'node:assert/strict';
import { test } from 'node:test';
import Type from 'typebox';
import {
  defineExtension,
  definePlugin,
  defineService,
  Kernel,
  sleep,
  systemClock,
} from '../src/index.ts';
import { base, catalog, consumer, entry, Greeter, harness, provider } from './helpers.ts';

test('按依赖激活：消费方排在提供方前面也会等提供方就绪', async () => {
  const h = harness();
  h.kernel.add(
    [entry('consumer'), entry('provider')],
    catalog(consumer('consumer', h.log), provider('provider', h.log)),
  );
  await h.kernel.settled();
  assert.equal(h.state('consumer').state, 'active');
  assert.deepEqual(h.log, ['activate provider', 'activate consumer hello']);
});

test('依赖消失时消费方先经过静止中回到 WAITING，依赖恢复后重新激活', async () => {
  const h = harness();
  h.kernel.add(
    [entry('provider'), entry('consumer')],
    catalog(provider('provider', h.log), consumer('consumer', h.log)),
  );
  await h.kernel.settled();
  const consumerInstance = h.state('consumer').instanceId;
  const providerInstance = h.state('provider').instanceId;
  h.log.length = 0;

  await h.kernel.disable('provider');
  assert.equal(h.state('provider').state, 'disposed');
  assert.equal(h.state('consumer').state, 'waiting');
  assert.match(h.state('consumer').reason ?? '', /缺少服务 greeter@1/);
  // 消费方先于提供方收尾；每个实例先吊销许可，再收尾，再撤销注册。
  assert.deepEqual(h.log, [
    `revoke ${consumerInstance}`,
    'quiesce consumer',
    'dispose consumer',
    `revoke ${providerInstance}`,
    'quiesce provider',
    'dispose provider',
  ]);

  await h.kernel.enable('provider');
  assert.equal(h.state('consumer').state, 'active');
  assert.notEqual(h.state('consumer').instanceId, consumerInstance);
});

test('WAITING 说明原因：主版本不兼容、未授予权限', async () => {
  const h = harness();
  const needsPermission = definePlugin({
    manifest: { ...base, id: 'speaker', permissions: ['speech.output'] },
    activate() {},
  });
  h.kernel.add(
    [entry('provider'), entry('consumer'), entry('speaker')],
    catalog(
      provider('provider', h.log, { major: 2 }),
      consumer('consumer', h.log),
      needsPermission,
    ),
  );
  await h.kernel.settled();
  assert.match(h.state('consumer').reason ?? '', /greeter 版本不兼容：需要 @1，现有 @2/);
  assert.match(h.state('speaker').reason ?? '', /未授予权限 speech\.output/);
});

test('可选依赖不阻塞激活', async () => {
  const h = harness();
  h.kernel.add([entry('consumer')], catalog(consumer('consumer', h.log, [`${Greeter.ref}?`])));
  await h.kernel.settled();
  assert.equal(h.state('consumer').state, 'active');
  assert.deepEqual(h.log, ['activate consumer -']);
});

test('注册按后注册先撤销的顺序撤销，扩展点监听者随之移除', async () => {
  const h = harness();
  const ping = defineExtension<'observe', string>('test.ping', 'observe');
  const plugin = definePlugin({
    manifest: { ...base, id: 'p' },
    activate(ctx) {
      ctx.register(() => {
        h.log.push('first');
      });
      ctx.on(ping, (value) => {
        h.log.push(`ping ${value}`);
      });
      ctx.register(() => {
        h.log.push('second');
      });
    },
  });
  h.kernel.add([entry('p')], catalog(plugin));
  await h.kernel.settled();
  h.kernel.extensions.observe(ping, 'a');
  await h.kernel.disable('p');
  h.kernel.extensions.observe(ping, 'b');
  assert.deepEqual(
    h.log.filter((l) => !l.startsWith('revoke')),
    ['ping a', 'second', 'first'],
  );
});

test('激活失败时撤销已注册的副作用，按退避重试，用尽后停在 FAILED', async () => {
  const h = harness();
  let attempts = 0;
  const flaky = definePlugin({
    manifest: { ...base, id: 'flaky' },
    activate(ctx) {
      attempts += 1;
      ctx.register(() => {
        h.log.push(`undo ${attempts}`);
      });
      throw new Error('启动失败');
    },
  });
  h.kernel.add([entry('flaky')], catalog(flaky));
  await h.kernel.settled();
  assert.equal(h.state('flaky').state, 'failed');
  await sleep(systemClock(), 100);
  await h.kernel.settled();
  assert.equal(attempts, 3);
  assert.deepEqual(h.log, ['undo 1', 'undo 2', 'undo 3']);
  assert.match(h.state('flaky').reason ?? '', /重试已用尽/);

  await h.kernel.retry('flaky');
  assert.equal(attempts, 4);
});

test('激活后没有提供清单声明的服务按失败处理', async () => {
  const h = harness({ retryDelaysMs: [] });
  const liar = definePlugin({
    manifest: { ...base, id: 'liar', provides: [Greeter.ref] },
    activate() {},
  });
  h.kernel.add([entry('liar')], catalog(liar));
  await h.kernel.settled();
  assert.match(h.state('liar').reason ?? '', /没有提供 greeter@1/);
});

test('插件只能取得自己声明的依赖，只能提供自己声明的服务', async () => {
  const h = harness({ retryDelaysMs: [] });
  const errors: string[] = [];
  const nosy = definePlugin({
    manifest: { ...base, id: 'nosy' },
    activate(ctx) {
      for (const attempt of [
        () => ctx.service(Greeter),
        () => ctx.provide(Greeter, { greet: () => '' }),
      ]) {
        try {
          attempt();
        } catch (error) {
          errors.push((error as Error).message);
        }
      }
    },
  });
  h.kernel.add([entry('provider'), entry('nosy')], catalog(provider('provider', h.log), nosy));
  await h.kernel.settled();
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? '', /没有声明必需依赖/);
  assert.match(errors[1] ?? '', /没有声明提供/);
});

test('收尾超过截止时间：强制运行撤销函数，并通知安全核', async () => {
  const h = harness();
  let forcedDuringDispose: boolean | undefined;
  const stuck = definePlugin({
    manifest: { ...base, id: 'stuck', tier: 'critical' },
    activate(ctx) {
      ctx.register(() => {
        forcedDuringDispose = ctx.forced;
      });
    },
    quiesce: () => new Promise(() => {}),
  });
  h.kernel.add([entry('stuck')], catalog(stuck));
  await h.kernel.settled();
  await h.kernel.disable('stuck');
  assert.equal(h.state('stuck').state, 'disposed');
  assert.equal(forcedDuringDispose, true);
  assert.equal(h.timeouts.length, 1);
  assert.equal(h.timeouts[0]?.tier, 'critical');
  assert.match(h.timeouts[0]?.error ?? '', /收尾 未在 100ms 内完成/);
});

test('进入静止中时中止信号先于收尾触发', async () => {
  const h = harness();
  let abortedBeforeQuiesce: boolean | undefined;
  let signal: AbortSignal | undefined;
  const worker = definePlugin({
    manifest: { ...base, id: 'worker' },
    activate(ctx) {
      signal = ctx.signal;
    },
    quiesce() {
      abortedBeforeQuiesce = signal?.aborted;
    },
  });
  h.kernel.add([entry('worker')], catalog(worker));
  await h.kernel.settled();
  assert.equal(signal?.aborted, false);
  await h.kernel.disable('worker');
  assert.equal(abortedBeforeQuiesce, true);
});

test('运行中报告失败：卸载为 FAILED，依赖方回到 WAITING，重试后恢复', async () => {
  const h = harness();
  let fail: ((error: Error) => void) | undefined;
  let runs = 0;
  const fragile = definePlugin({
    manifest: { ...base, id: 'fragile', provides: [Greeter.ref] },
    activate(ctx) {
      runs += 1;
      fail = ctx.fail;
      ctx.provide(Greeter, { greet: () => `run ${runs}` });
    },
  });
  h.kernel.add(
    [entry('fragile'), entry('consumer')],
    catalog(fragile, consumer('consumer', h.log)),
  );
  await h.kernel.settled();
  fail?.(new Error('设备断开'));
  await h.kernel.settled();
  assert.equal(h.state('fragile').state, 'failed');
  assert.match(h.state('fragile').reason ?? '', /设备断开/);
  assert.equal(h.state('consumer').state, 'waiting');
  await sleep(systemClock(), 60);
  await h.kernel.settled();
  assert.equal(h.state('consumer').state, 'active');
  assert.ok(h.log.includes('activate consumer run 2'));
});

test('热替换成功：新实例接管服务，依赖方重新激活', async () => {
  const h = harness();
  h.kernel.add(
    [entry('provider'), entry('consumer')],
    catalog(provider('provider', h.log), consumer('consumer', h.log)),
  );
  await h.kernel.settled();
  const result = await h.kernel.replace(
    'provider',
    provider('provider', h.log, { word: 'bonjour' }),
  );
  await h.kernel.settled();
  assert.deepEqual(result, { ok: true });
  assert.equal(h.state('consumer').state, 'active');
  assert.equal(h.log.at(-1), 'activate consumer bonjour');
});

test('热替换失败时保留旧实例', async () => {
  const h = harness();
  h.kernel.add(
    [entry('provider'), entry('consumer')],
    catalog(provider('provider', h.log), consumer('consumer', h.log)),
  );
  await h.kernel.settled();
  const before = h.kernel.snapshot();
  const broken = definePlugin({
    manifest: { ...base, id: 'provider', provides: [Greeter.ref] },
    activate(ctx) {
      ctx.register(() => {
        h.log.push('undo broken');
      });
      throw new Error('新版本坏了');
    },
  });
  const result = await h.kernel.replace('provider', broken);
  await h.kernel.settled();
  assert.deepEqual(result, { ok: false, error: '新版本坏了' });
  assert.deepEqual(h.kernel.snapshot(), before);
  assert.equal(h.log.at(-1), 'undo broken');
});

test('关键平面只能在维护态替换', async () => {
  const h = harness();
  h.kernel.add([entry('provider')], catalog(provider('provider', h.log, { tier: 'critical' })));
  await h.kernel.settled();
  const refused = await h.kernel.replace(
    'provider',
    provider('provider', h.log, { tier: 'critical' }),
  );
  assert.deepEqual(refused, { ok: false, error: '关键平面只能在维护态替换' });
  h.setMaintenance(true);
  assert.deepEqual(
    await h.kernel.replace('provider', provider('provider', h.log, { tier: 'critical' })),
    { ok: true },
  );
});

test('配置按清单的 Schema 校验，不合法时停在 FAILED 且不重试', async () => {
  const h = harness();
  let received: unknown;
  const configured = definePlugin({
    manifest: {
      ...base,
      id: 'configured',
      config: Type.Object({ rate: Type.Number({ minimum: 1 }) }),
    },
    activate(ctx) {
      received = ctx.config;
    },
  });
  h.kernel.add(
    [
      entry('good', 'configured', { config: { rate: 2 } }),
      entry('bad', 'configured', { config: { rate: 0 } }),
    ],
    catalog(configured),
  );
  await h.kernel.settled();
  assert.deepEqual(received, { rate: 2 });
  assert.equal(h.state('bad').state, 'failed');
  assert.match(h.state('bad').reason ?? '', /配置不合法：\/rate/);
});

test('停止宿主时按逆序卸载全部插件', async () => {
  const h = harness();
  h.kernel.add(
    [entry('provider'), entry('consumer')],
    catalog(provider('provider', h.log), consumer('consumer', h.log)),
  );
  await h.kernel.settled();
  h.log.length = 0;
  await h.kernel.shutdown();
  assert.deepEqual(
    h.log.filter((l) => l.startsWith('dispose')),
    ['dispose consumer', 'dispose provider'],
  );
  assert.ok(h.kernel.snapshot().every((e) => e.state === 'disposed'));
});

test('状态变化逐一通知', async () => {
  const transitions: string[] = [];
  const h = harness({ onTransition: (t) => transitions.push(`${t.entryId}:${t.from}->${t.to}`) });
  h.kernel.add([entry('provider')], catalog(provider('provider', h.log)));
  await h.kernel.settled();
  await h.kernel.disable('provider');
  assert.deepEqual(transitions, [
    'provider:waiting->loading',
    'provider:loading->active',
    'provider:active->quiescing',
    'provider:quiescing->unloading',
    'provider:unloading->disposed',
  ]);
});

test('吊销执行许可失败时不当作已吊销，按收尾超时升级给安全核', async () => {
  const h = harness();
  const kernel = new Kernel({
    clock: systemClock(),
    safety: {
      revokeLeases: () => {
        throw new Error('安全核拒绝');
      },
      quiesceTimedOut: (event) => h.timeouts.push(event),
      inMaintenance: () => false,
    },
  });
  kernel.add([entry('provider')], catalog(provider('provider', h.log)));
  await kernel.settled();
  await kernel.disable('provider');
  assert.equal(h.timeouts.length, 1);
  assert.match(h.timeouts[0]?.error ?? '', /吊销执行许可失败：安全核拒绝/);
});

test('插件自己声明提供的服务不能顶替必需依赖', async () => {
  const h = harness();
  const selfish = definePlugin({
    manifest: { ...base, id: 'selfish', provides: [Greeter.ref], inject: [Greeter.ref] },
    activate(ctx) {
      ctx.provide(Greeter, { greet: () => 'me' });
    },
  });
  h.kernel.add([entry('selfish')], catalog(selfish));
  await h.kernel.settled();
  assert.equal(h.state('selfish').state, 'waiting');
  assert.match(h.state('selfish').reason ?? '', /缺少服务 greeter@1/);
});

test('热替换前检查新版本的依赖，不满足时不动旧实例', async () => {
  const h = harness();
  h.kernel.add([entry('provider')], catalog(provider('provider', h.log)));
  await h.kernel.settled();
  const before = h.kernel.snapshot();
  const needy = definePlugin({
    manifest: { ...base, id: 'provider', provides: [Greeter.ref], inject: ['missing@1'] },
    activate: () => assert.fail('不应激活'),
  });
  assert.deepEqual(await h.kernel.replace('provider', needy), {
    ok: false,
    error: '缺少服务 missing@1',
  });
  assert.deepEqual(h.kernel.snapshot(), before);
});

test('替换停在 FAILED 的条目会启动新实现', async () => {
  const h = harness({ retryDelaysMs: [] });
  const broken = definePlugin({
    manifest: { ...base, id: 'provider', provides: [Greeter.ref] },
    activate: () => {
      throw new Error('坏了');
    },
  });
  h.kernel.add([entry('provider')], catalog(broken));
  await h.kernel.settled();
  assert.equal(h.state('provider').state, 'failed');
  assert.deepEqual(await h.kernel.replace('provider', provider('provider', h.log)), { ok: true });
  await h.kernel.settled();
  assert.equal(h.state('provider').state, 'active');
});

test('激活期间注册的监听者在发布前收不到分发；替换失败的实例永远收不到', async () => {
  const h = harness();
  const ping = defineExtension<'observe', string>('test.staged', 'observe');
  const gate = Promise.withResolvers<void>();
  const slow = definePlugin({
    manifest: { ...base, id: 'slow' },
    async activate(ctx) {
      ctx.on(ping, (value) => {
        h.log.push(`slow ${value}`);
      });
      await gate.promise;
    },
  });
  h.kernel.add([entry('slow')], catalog(slow));
  await new Promise((resolve) => setImmediate(resolve));
  h.kernel.extensions.observe(ping, 'early');
  gate.resolve();
  await h.kernel.settled();
  h.kernel.extensions.observe(ping, 'late');
  assert.deepEqual(h.log, ['slow late']);

  const failing = definePlugin({
    manifest: { ...base, id: 'slow' },
    async activate(ctx) {
      ctx.on(ping, (value) => {
        h.log.push(`failing ${value}`);
      });
      throw new Error('新版本坏了');
    },
  });
  assert.equal((await h.kernel.replace('slow', failing)).ok, false);
  h.kernel.extensions.observe(ping, 'after');
  assert.deepEqual(h.log, ['slow late', 'slow after']);
});

test('清单中同名服务重复、批量加入中有错误时整批不写入', () => {
  const h = harness();
  const twice = definePlugin({
    manifest: { ...base, id: 'twice', provides: ['greeter@1', 'greeter@2'] },
    activate() {},
  });
  assert.throws(() => h.kernel.add([entry('twice')], catalog(twice)), /greeter 重复/);
  assert.throws(
    () => h.kernel.add([entry('provider'), entry('ghost')], catalog(provider('provider', h.log))),
    /未知插件 ghost/,
  );
  assert.deepEqual(h.kernel.snapshot(), []);
});

test('宿主停止后不再接受插件变更', async () => {
  const h = harness();
  h.kernel.add([entry('provider')], catalog(provider('provider', h.log)));
  await h.kernel.settled();
  await h.kernel.shutdown();
  await assert.rejects(h.kernel.enable('provider'), /不再接受插件变更/);
  assert.throws(
    () => h.kernel.add([entry('x', 'provider')], catalog(provider('provider', h.log))),
    /不再接受/,
  );
  assert.equal(h.state('provider').state, 'disposed');
});

test('配置按 Schema 补齐缺省值后交给插件，不改动 profile 中的原值', async () => {
  const h = harness();
  let received: unknown;
  const withDefaults = definePlugin({
    manifest: {
      ...base,
      id: 'defaults',
      config: Type.Object({
        rate: Type.Number({ default: 5 }),
        name: Type.String({ default: 'x' }),
      }),
    },
    activate(ctx) {
      received = ctx.config;
    },
  });
  const raw = { name: 'given' };
  h.kernel.add([entry('defaults', 'defaults', { config: raw })], catalog(withDefaults));
  await h.kernel.settled();
  assert.deepEqual(received, { rate: 5, name: 'given' });
  assert.deepEqual(raw, { name: 'given' });
});

test('按实例提供的服务：每个实例拿到为它生成的实现', async () => {
  const h = harness();
  const Identity = defineService<{ who: string }>('identity', 1);
  h.kernel.provideScoped(Identity, ({ instanceId }) => ({ who: instanceId }));
  const seen: string[] = [];
  const asker = (id: string) =>
    definePlugin({
      manifest: { ...base, id, inject: [Identity.ref] },
      activate(ctx) {
        seen.push(`${ctx.instanceId}=${ctx.service(Identity).who}`);
      },
    });
  h.kernel.add([entry('a'), entry('b')], catalog(asker('a'), asker('b')));
  await h.kernel.settled();
  assert.deepEqual(seen, ['a#1=a#1', 'b#2=b#2']);
});

test('实例编号带启动标识，重启后不与上次重复', async () => {
  const log: string[] = [];
  const first = new Kernel({
    clock: systemClock(),
    safety: { revokeLeases: () => {}, quiesceTimedOut: () => {}, inMaintenance: () => false },
    bootId: 'a1',
  });
  first.add([entry('provider')], catalog(provider('provider', log)));
  await first.settled();
  assert.equal(first.snapshot()[0]?.instanceId, 'provider#a1.1');
});
