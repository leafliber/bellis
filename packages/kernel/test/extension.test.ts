import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineExtension, Extensions } from '../src/index.ts';

function setup() {
  const failures: string[] = [];
  const extensions = new Extensions((name, error) =>
    failures.push(`${name}: ${(error as Error).message}`),
  );
  return { extensions, failures };
}

test('观察：按注册顺序同步调用，异常被记录而不影响其他监听者', async () => {
  const { extensions, failures } = setup();
  const point = defineExtension<'observe', number>('t.observe', 'observe');
  const seen: string[] = [];
  extensions.add(point, (n) => seen.push(`a${n}`));
  extensions.add(point, () => {
    throw new Error('坏了');
  });
  extensions.add(point, async () => {
    throw new Error('异步也坏了');
  });
  extensions.add(point, (n) => seen.push(`b${n}`));
  extensions.observe(point, 1);
  assert.deepEqual(seen, ['a1', 'b1']);
  await Promise.resolve();
  assert.deepEqual(failures, ['t.observe: 坏了', 't.observe: 异步也坏了']);
});

test('包装：环绕中间件，可改写参数与结果，不调用 next 即短路', async () => {
  const { extensions } = setup();
  const point = defineExtension<'wrap', string, string>('t.wrap', 'wrap');
  extensions.add(point, async (text, next) => `[${await next(`${text}!`)}]`);
  extensions.add(point, async (text, next) => (text.startsWith('stop') ? 'short' : next(text)));
  assert.equal(await extensions.wrap(point, 'hi', async (t) => t.toUpperCase()), '[HI!]');
  assert.equal(await extensions.wrap(point, 'stop', async (t) => t), '[short]');
});

test('并行：等待全部监听者，收集全部异常后一并抛出', async () => {
  const { extensions } = setup();
  const point = defineExtension<'parallel', void>('t.parallel', 'parallel');
  const done: string[] = [];
  extensions.add(point, async () => {
    done.push('a');
  });
  extensions.add(point, async () => {
    throw new Error('x');
  });
  extensions.add(point, async () => {
    throw new Error('y');
  });
  await assert.rejects(extensions.parallel(point, undefined), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.deepEqual(done, ['a']);
});

test('串行：逐个等待，第一个非空返回值生效', async () => {
  const { extensions } = setup();
  const point = defineExtension<'serial', number, string>('t.serial', 'serial');
  const called: string[] = [];
  extensions.add(point, async () => {
    called.push('a');
    return undefined;
  });
  extensions.add(point, async (n) => {
    called.push('b');
    return n > 0 ? 'positive' : undefined;
  });
  extensions.add(point, () => {
    called.push('c');
    return 'fallback';
  });
  assert.equal(await extensions.serial(point, 1), 'positive');
  assert.deepEqual(called, ['a', 'b']);
  assert.equal(await extensions.serial(point, 0), 'fallback');
});

test('首个决定：只允许同步监听者', () => {
  const { extensions } = setup();
  const point = defineExtension<'first', number, string>('t.first', 'first');
  extensions.add(point, (n) => (n > 0 ? 'yes' : undefined));
  assert.equal(extensions.first(point, 1), 'yes');
  extensions.add(point, (() => Promise.resolve('late')) as unknown as () => string);
  assert.throws(() => extensions.first(point, 0), /只允许同步监听者/);
});

test('同名扩展点不能换一种模式使用', () => {
  const { extensions } = setup();
  extensions.add(defineExtension<'observe', void>('t.mode', 'observe'), () => {});
  assert.throws(
    () => extensions.add(defineExtension<'serial', void>('t.mode', 'serial'), () => undefined),
    /已声明为 observe/,
  );
});

test('撤销后不再收到分发；分发中途的注册不影响本次分发', () => {
  const { extensions } = setup();
  const point = defineExtension<'observe', void>('t.dispose', 'observe');
  const seen: string[] = [];
  const dispose = extensions.add(point, () => {
    seen.push('a');
    extensions.add(point, () => seen.push('late'));
  });
  extensions.observe(point, undefined);
  dispose();
  extensions.observe(point, undefined);
  assert.deepEqual(seen, ['a', 'late']);
});
