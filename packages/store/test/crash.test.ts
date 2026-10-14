import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { executeOnce, ResourceIsolated, SimulatedCrash, StateStore } from '../src/index.ts';
import { base, counter, counts, fold, tempDb } from './helpers.ts';

type Command =
  | { kind: 'append'; type: string }
  | { kind: 'exec'; key: string; fails: boolean }
  | { kind: 'token'; resource: string };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant('append' as const), type: fc.constantFrom('a.done', 'b.done') }),
  fc.record({
    kind: fc.constant('exec' as const),
    key: fc.constantFrom('k0', 'k1', 'k2', 'k3'),
    fails: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('token' as const),
    resource: fc.constantFrom('stage.audio', 'game.input'),
  }),
);

interface World {
  effects: Map<string, number>;
  tokens: Map<string, number>;
}

/** 执行一串命令。目标因结果未知被隔离时不执行，这是预期行为。 */
async function run(store: StateStore, commands: readonly Command[], world: World): Promise<void> {
  for (const c of commands) {
    if (c.kind === 'append') {
      store.append(c.type, {});
    } else if (c.kind === 'token') {
      const value = store.nextToken(c.resource);
      world.tokens.set(c.resource, Math.max(world.tokens.get(c.resource) ?? 0, value));
    } else {
      try {
        await executeOnce(store, base(c.key), { key: c.key }, async () => {
          world.effects.set(c.key, (world.effects.get(c.key) ?? 0) + 1);
          if (c.fails) throw new Error('设备拒绝');
          return { ok: true };
        });
      } catch (error) {
        if (!(error instanceof ResourceIsolated)) throw error;
      }
    }
  }
}

function open(path: string, fault?: (point: string) => void): StateStore {
  return StateStore.open({
    path,
    projections: [counts],
    now: counter(),
    ...(fault ? { fault } : {}),
  });
}

/** 空跑一遍，数出打开数据库并执行这串命令会经过多少个写入点（含读取点）。 */
async function countPoints(commands: readonly Command[]): Promise<number> {
  const db = tempDb();
  let points = 0;
  const store = open(db.path, () => {
    points += 1;
  });
  try {
    await run(store, commands, { effects: new Map(), tokens: new Map() });
  } finally {
    store.close();
    db.cleanup();
  }
  return points;
}

test('在任一写入点崩溃后重启：状态一致，副作用不重做，执行中的意图标为 unknown，令牌不回退', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(command, { minLength: 1, maxLength: 12 }),
      fc.nat(),
      async (commands, pick) => {
        // 保证每一轮都真的在某个点崩溃（包括打开数据库时）。
        const points = await countPoints(commands);
        const crashAt = 1 + (pick % points);
        const db = tempDb();
        const world: World = { effects: new Map(), tokens: new Map() };
        try {
          let hits = 0;
          let crashed = false;
          let first: StateStore | undefined;
          try {
            first = open(db.path, (point) => {
              hits += 1;
              if (hits === crashAt) throw new SimulatedCrash(point);
            });
            await run(first, commands, world);
          } catch (error) {
            if (!(error instanceof SimulatedCrash)) throw error;
            crashed = true;
          }
          first?.close();
          assert.ok(crashed, `应在第 ${crashAt}/${points} 个点崩溃`);

          const second = open(db.path);
          try {
            const report = second.recover();
            assert.equal(second.intentsIn('pending').length, 0);
            assert.equal(second.intentsIn('executing').length, 0);
            for (const abandoned of report.abandoned) {
              assert.equal(
                world.effects.get(abandoned.key) ?? 0,
                0,
                `放弃的意图 ${abandoned.key} 不应执行过`,
              );
            }
            for (const [resource, seen] of world.tokens) {
              assert.ok(second.token(resource) >= seen, `${resource} 令牌回退`);
            }
            assert.deepEqual(second.view(counts), fold(counts, second.events()));

            // 重启后原样重新提交：已有意图的键不再执行，每个键的副作用最多一次。
            await run(second, commands, world);
            for (const [key, times] of world.effects)
              assert.ok(times <= 1, `${key} 执行了 ${times} 次`);
            assert.deepEqual(second.view(counts), fold(counts, second.events()));
          } finally {
            second.close();
          }
        } finally {
          db.cleanup();
        }
      },
    ),
    { numRuns: 60 },
  );
});

const fixture = fileURLToPath(new URL('./fixtures/crash-run.ts', import.meta.url));

for (const [point, expected] of [
  ['authorize:after-commit', { state: 'failed', effects: 0 }],
  ['effect:after', { state: 'unknown', effects: 1 }],
  ['complete:before-commit', { state: 'unknown', effects: 1 }],
  ['complete:after-commit', { state: 'succeeded', effects: 1 }],
] as const) {
  test(`进程在 ${point} 被强制终止后，重启恢复正确`, async () => {
    const db = tempDb();
    const effectsLog = `${db.path}.effects`;
    try {
      const child = spawnSync(process.execPath, [fixture, db.path, effectsLog, point], {
        encoding: 'utf8',
      });
      assert.notEqual(child.status, 0, `子进程应被强制终止：${child.stderr}`);
      const store = StateStore.open({ path: db.path });
      try {
        store.recover();
        assert.equal(store.intentByKey('k')?.state, expected.state);
        const ran = () => readFileSync(effectsLog, { encoding: 'utf8', flag: 'a+' }).length;
        assert.equal(ran(), expected.effects);
        const again = await executeOnce(store, base('k'), { key: 'k' }, async () =>
          assert.fail('不应重做'),
        );
        assert.equal(again.executed, false);
      } finally {
        store.close();
      }
    } finally {
      db.cleanup();
      rmSync(effectsLog, { force: true });
    }
  });
}
