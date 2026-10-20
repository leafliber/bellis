import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DanmakuService } from '@bellis/audience';
import { Operation } from '../src/index.ts';
import { entry, fakePlatform, fastConfig, GRANT, linkReady, waitFor, world } from './helpers.ts';
import { assertCleanLogs, dm } from './messages.ts';

type Gap = {
  reason: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  recovered?: boolean;
};

function gaps(w: Awaited<ReturnType<typeof world>>) {
  return {
    started: w.events('danmaku.gap-started').map((e) => e.data as Gap),
    ended: w.events('danmaku.gap-ended').map((e) => e.data as Gap),
  };
}

test('地址轮换：一个连不上（拒绝升级、迟迟不回认证）就换下一个；断开后记缺口并重连，缺口结束带时长', async () => {
  const fake = await fakePlatform({
    links: (f) => [f.wsUrl('/reject'), f.wsUrl('/silent'), f.wsUrl('/sub')],
  });
  const config = fastConfig(fake, { authTimeoutMs: 500 });
  const w = await world([entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT })]);
  try {
    w.listen();
    await linkReady(w);
    assert.deepEqual(
      fake.upgrades.map((u) => u.path),
      ['/reject', '/silent', '/sub'],
    );
    const failed = w.logged('bilibili.link-failed').map((l) => String(l.fields.reason));
    assert.match(failed[0] ?? '', /HTTP 503/);
    assert.match(failed[1] ?? '', /认证回复未在 500ms 内到达/);
    // 一开始就没连上：缺口从开始接入时算起，连上即结束。
    let g = gaps(w);
    assert.equal(g.started.length, 1);
    assert.match(g.started[0]?.reason ?? '', /HTTP 503/);
    assert.equal(g.ended.length, 1);
    assert.equal(g.ended[0]?.recovered, true);
    assert.ok((g.ended[0]?.durationMs ?? 0) >= 500, '缺口时长含等认证超时的时间');

    fake.push(dm(1));
    await waitFor(() => w.received.length === 1, '断开前的弹幕');
    // 缺口也经 danmaku@1 交给订阅者（投票据此记下与投票时段重叠的缺口）。
    const source = w.service(DanmakuService);
    assert.equal(source.gap?.(), undefined);
    const notified: Array<string | undefined> = [];
    const unsubscribe = source.onGap?.((gap) => notified.push(gap?.reason));
    fake.drop();
    await linkReady(w, 2);
    unsubscribe?.();
    assert.equal(notified.length, 2);
    assert.match(notified[0] ?? '', /长连接断开/);
    assert.equal(notified[1], undefined);
    assert.equal(source.gap?.(), undefined);
    assert.equal(fake.upgrades.length, 6, '断开后从下一个地址起再轮一遍');
    g = gaps(w);
    assert.equal(g.started.length, 2);
    assert.match(g.started[1]?.reason ?? '', /长连接断开/);
    assert.equal(g.ended.length, 2);
    assert.ok((g.ended[1]?.durationMs ?? -1) >= 0);
    assert.ok((g.ended[1]?.endedAt ?? 0) >= (g.started[1]?.startedAt ?? Infinity));
    // 重连后平台重发了断开前的一条：不重复交出。
    fake.push([dm(1), dm(2)], 'zlib');
    await waitFor(() => w.received.length === 2, '重连后的弹幕');
    assert.deepEqual(
      w.received.map((d) => d.id),
      ['msg-1', 'msg-2'],
    );
    assert.equal(fake.games.length, 1, '只是长连接断开，场次不重开');
    assertCleanLogs(w.logs);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('长连接迟迟收不到心跳回复视为断开，记缺口后重连', async () => {
  const fake = await fakePlatform();
  const config = fastConfig(fake, { heartbeatIntervalMs: 50, idleTimeoutMs: 500 });
  const w = await world([entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT })]);
  try {
    await waitFor(() => fake.authed.length === 1, '长连接认证');
    await waitFor(
      () => fake.packets.filter((p) => p.operation === Operation.Heartbeat).length >= 3,
      '心跳有回复时连接保持',
    );
    assert.equal(fake.connections.length, 1);
    fake.muteHeartbeat = true;
    await waitFor(() => w.logged('bilibili.link-closed').length === 1, '空闲超时断开');
    assert.match(String(w.logged('bilibili.link-closed')[0]?.fields.reason), /收不到任何包/);
    fake.muteHeartbeat = false;
    await waitFor(() => gaps(w).ended.length === 1, '重连后缺口结束');
    assert.match(gaps(w).started[0]?.reason ?? '', /收不到任何包/);
    assert.equal(fake.games.length, 1);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('7002 等一分钟以上（此处按配置）、7001 等约 10 秒（同上）后重试；等待期间是缺口', async () => {
  const fake = await fakePlatform();
  fake.failNext.start.push(7002, 7001);
  const config = fastConfig(fake, { occupiedRetryMs: 300, settlingRetryMs: 150 });
  const w = await world([entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT })]);
  try {
    await linkReady(w);
    const starts = fake.calls('start');
    assert.deepEqual(
      starts.map((s) => s.code),
      [7002, 7001, 0],
    );
    assert.ok(starts.every((s) => s.verified));
    const [a, b, c] = starts.map((s) => s.at) as [number, number, number];
    // 计时器只会晚到；留 20ms 给墙钟与单调时钟的取整差。
    assert.ok(b - a >= 280, `7002 后等了 ${b - a}ms`);
    assert.ok(c - b >= 130, `7001 后等了 ${c - b}ms`);
    const failed = w
      .logged('bilibili.session-failed')
      .map((l) => [l.fields.code, l.fields.retryInMs]);
    assert.deepEqual(failed, [
      [7002, 300],
      [7001, 150],
    ]);
    const g = gaps(w);
    assert.equal(g.started.length, 1);
    assert.match(g.started[0]?.reason ?? '', /7002/);
    assert.equal(g.ended.length, 1);
    assert.ok((g.ended[0]?.durationMs ?? 0) >= 430);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('收到 INTERACTION_END：关闭旧场次后重新开启，用新的 auth_body 认证；别的场次的 INTERACTION_END 不理', async () => {
  const fake = await fakePlatform();
  const w = await world([
    entry('danmaku', 'danmaku-bilibili', { config: fastConfig(fake), grant: GRANT }),
  ]);
  try {
    w.listen();
    await waitFor(() => fake.authed.length === 1, '长连接认证');
    fake.push({ cmd: 'LIVE_OPEN_PLATFORM_INTERACTION_END', data: { game_id: 'game-0' } });
    fake.push(dm(1));
    await waitFor(() => w.received.length === 1, '别的场次的结束不影响接收');
    assert.equal(w.logged('bilibili.interaction-end-ignored').length, 1);

    fake.interactionEnd();
    await waitFor(() => fake.games.length === 2 && fake.authed.length === 1, '重新开启并连上');
    const ends = fake.calls('end');
    assert.equal(ends[0]?.body?.game_id, 'game-1');
    const auths = fake.packets.filter((p) => p.operation === Operation.Auth);
    assert.match(auths.at(-1)?.body ?? '', /game-2/);
    const g = gaps(w);
    assert.match(g.started[0]?.reason ?? '', /INTERACTION_END/);
    await waitFor(() => gaps(w).ended.length === 1, '缺口结束');
    fake.push(dm(2));
    await waitFor(() => w.received.length === 2, '新场次的弹幕');
    assertCleanLogs(w.logs);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('项目心跳返回 7003 立即重开场次；其它错误连续达到上限才重开', async () => {
  const fake = await fakePlatform();
  const config = fastConfig(fake, { projectHeartbeatMs: 40, projectHeartbeatFailures: 2 });
  const w = await world([entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT })]);
  try {
    await waitFor(() => fake.authed.length === 1, '长连接认证');
    fake.failNext.heartbeat.push(7003);
    await waitFor(() => fake.games.length === 2 && fake.authed.length === 1, '7003 后重开');
    assert.match(gaps(w).started[0]?.reason ?? '', /项目心跳失败.*7003/);
    assert.ok(fake.calls('end').some((c) => c.body?.game_id === 'game-1'));

    // 一次失败不重开；连续两次才重开。
    fake.failNext.heartbeat.push(5000);
    await waitFor(() => w.logged('bilibili.heartbeat-recovered').length === 1, '一次失败后恢复');
    assert.equal(fake.games.length, 2);
    fake.failNext.heartbeat.push(5000, 5000);
    await waitFor(() => fake.games.length === 3 && fake.authed.length === 1, '连续失败后重开');
    assert.match(gaps(w).started.at(-1)?.reason ?? '', /项目心跳连续失败 2 次/);
    assert.ok(
      fake.calls('end').some((c) => c.body?.game_id === 'game-2' && c.code === 0),
      '能关就关',
    );
  } finally {
    await w.close();
    await fake.close();
  }
});

test('长连接认证被拒：重新开启场次后再认证', async () => {
  const fake = await fakePlatform();
  fake.rejectAuth = true;
  const w = await world([
    entry('danmaku', 'danmaku-bilibili', { config: fastConfig(fake), grant: GRANT }),
  ]);
  try {
    await waitFor(() => fake.packets.some((p) => p.operation === Operation.Auth), '第一次认证');
    fake.rejectAuth = false;
    await waitFor(() => fake.authed.length === 1, '重开后认证成功');
    assert.ok(fake.games.length >= 2);
    assert.match(gaps(w).started[0]?.reason ?? '', /认证被拒/);
    assert.match(String(w.logged('bilibili.session-invalid')[0]?.fields.reason), /长连接认证失败/);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('场次开得太久时例行重开', async () => {
  const fake = await fakePlatform();
  const config = fastConfig(fake, { maxSessionAgeMs: 300 });
  const w = await world([entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT })]);
  try {
    await waitFor(() => fake.games.length >= 2 && fake.authed.length === 1, '例行重开');
    assert.match(gaps(w).started[0]?.reason ?? '', /例行重开/);
    assert.ok(fake.calls('end').some((c) => c.body?.game_id === 'game-1' && c.code === 0));
  } finally {
    await w.close();
    await fake.close();
  }
});

test('无场次编号（game_id 为空串）：不发项目心跳、停用时不关闭场次；断线照常重连并记缺口，INTERACTION_END 不按编号过滤', async () => {
  const fake = await fakePlatform({ emptyGameId: true });
  // 项目心跳间隔很短、一次失败就判失效：若发了项目心跳，下面这段时间里早已发出并引起重开。
  const config = fastConfig(fake, {
    heartbeatIntervalMs: 20,
    projectHeartbeatMs: 20,
    projectHeartbeatFailures: 1,
  });
  const w = await world([entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT })]);
  try {
    w.listen();
    await linkReady(w);
    const opened = w.logged('bilibili.session-opened')[0];
    assert.equal(opened?.fields.gameId, '');
    assert.equal(opened?.fields.noGameId, true, '日志里看得出是无场次编号的场次');
    const beats = () => fake.packets.filter((p) => p.operation === Operation.Heartbeat).length;
    await waitFor(() => beats() >= 5, '长连接心跳照常');
    assert.equal(fake.calls('heartbeat').length, 0, '不发项目心跳');

    fake.drop();
    await linkReady(w, 2);
    let g = gaps(w);
    assert.equal(g.started.length, 1);
    assert.match(g.started[0]?.reason ?? '', /长连接断开/);
    assert.equal(g.ended.length, 1);
    assert.equal(g.ended[0]?.recovered, true);
    fake.push(dm(1));
    await waitFor(() => w.received.length === 1, '重连后的弹幕');
    assert.equal(fake.games.length, 1, '断线只重连，不重开场次');

    // 分不出是不是自己的场次：带着别的编号也重开；旧场次不调用关闭。
    fake.interactionEnd('game-x');
    await linkReady(w, 3);
    assert.equal(fake.games.length, 2);
    g = gaps(w);
    assert.match(g.started[1]?.reason ?? '', /INTERACTION_END/);
    const before = beats();
    await waitFor(() => beats() >= before + 5, '新场次的长连接心跳照常');
    assert.equal(fake.calls('heartbeat').length, 0, '新场次也不发项目心跳');

    await w.kernel.disable('danmaku');
    assert.equal(fake.calls('end').length, 0, '不调用 /v2/app/end');
    const skipped = w.logged('bilibili.end-skipped');
    assert.equal(skipped.length, 2, '重开与停用各跳过一次');
    assert.ok(skipped.every((l) => l.fields.noGameId === true));
    assertCleanLogs(w.logs);
  } finally {
    await w.close();
    await fake.close();
  }
});
