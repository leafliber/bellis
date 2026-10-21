import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureText, LlmHealth } from '../src/index.ts';

test('就绪：还没调用过算就绪；连续失败少于阈值仍就绪，达到阈值未就绪，成功后恢复', () => {
  let now = 1000;
  const health = new LlmHealth(3, () => now);
  assert.equal(health.ready, true);
  assert.equal(health.status, '就绪（还没有调用过）');
  assert.deepEqual(health.failures, { consecutive: 0 });

  health.failed({ kind: 'server', status: 503 });
  now = 2000;
  health.failed({ kind: 'timeout' });
  assert.equal(health.ready, true);
  assert.equal(health.status, '就绪（连续失败 2 次，最近一次：timeout）');
  now = 3000;
  health.failed({ kind: 'rate_limit', status: 429, code: 'RateLimitExceeded' });
  assert.equal(health.ready, false);
  assert.equal(health.status, '连续失败 3 次（最近一次：rate_limit，HTTP 429，RateLimitExceeded）');
  assert.deepEqual(health.failures, {
    consecutive: 3,
    last: { kind: 'rate_limit', at: 3000, status: 429, code: 'RateLimitExceeded' },
  });

  health.succeeded();
  assert.equal(health.ready, true);
  assert.equal(health.status, '就绪');
  // 最近一次失败仍留着，供操作员查看；连续失败清零。
  assert.deepEqual(health.failures, {
    consecutive: 0,
    last: { kind: 'rate_limit', at: 3000, status: 429, code: 'RateLimitExceeded' },
  });
});

test('鉴权失败一出现就未就绪，直到下一次成功；取消不算失败', () => {
  const health = new LlmHealth(3, () => 5000);
  health.failed({ kind: 'auth', status: 401, code: 'AuthenticationError' });
  assert.equal(health.ready, false);
  assert.equal(
    health.status,
    '鉴权失败（auth，HTTP 401，AuthenticationError），下一次成功之前不就绪',
  );
  // 之后别的类别的失败不清掉鉴权失败。
  health.failed({ kind: 'network' });
  assert.equal(health.ready, false);
  assert.match(health.status, /^鉴权失败/);
  health.failed({ kind: 'aborted' });
  assert.equal(health.failures.consecutive, 2, '取消不计');
  health.succeeded();
  assert.equal(health.ready, true);
});

test('失败的说明只有类别、HTTP 状态与错误码', () => {
  assert.equal(failureText({ kind: 'timeout' }), 'timeout');
  assert.equal(failureText({ kind: 'server', status: 502 }), 'server，HTTP 502');
  assert.equal(
    failureText({ kind: 'request', code: 'InvalidParameter' }),
    'request，InvalidParameter',
  );
});
