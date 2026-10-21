import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DanmakuService } from '@bellis/audience';
import { parseLines, TelemetryMemoryService } from '@bellis/telemetry';
import { Operation } from '../src/index.ts';
import { AUTH_MARKER } from './fake-platform.ts';
import {
  APP_ID,
  entry,
  fakePlatform,
  fastConfig,
  GRANT,
  SECRETS,
  waitFor,
  world,
} from './helpers.ts';
import { assertCleanLogs, command, dm, FACE, NICK, TEXT } from './messages.ts';

test('激活不等场次开启；认证之前不发别的包；长连接心跳与项目心跳按间隔发出', async () => {
  const fake = await fakePlatform({ startDelayMs: 300, authReplyDelayMs: 150 });
  const config = fastConfig(fake, { heartbeatIntervalMs: 40, projectHeartbeatMs: 40 });
  const w = await world([entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT })]);
  try {
    assert.equal(w.state('danmaku')?.state, 'active');
    assert.equal(fake.games.length, 0, '激活时场次还没开启');
    await waitFor(() => fake.authed.length === 1, '长连接认证');
    const first = fake.packets.find((p) => p.connection === 1);
    assert.equal(first?.operation, Operation.Auth);
    assert.ok(first?.body.includes(`${AUTH_MARKER}-game-1`), '认证正文原样放 auth_body');
    assert.deepEqual(fake.early, [], '认证回复之前不发别的包');

    await waitFor(
      () => fake.packets.filter((p) => p.operation === Operation.Heartbeat).length >= 3,
      '长连接心跳',
    );
    await waitFor(() => fake.calls('heartbeat').length >= 2, '项目心跳');
    for (const call of fake.calls('heartbeat')) {
      assert.equal(call.verified, true);
      assert.equal(call.code, 0);
      assert.deepEqual(call.body, { game_id: 'game-1' });
    }
    assert.deepEqual(fake.calls('start')[0]?.body, {
      code: SECRETS['bilibili-code'],
      app_id: APP_ID,
    });
    assert.ok(w.logged('bilibili.session-opened').some((l) => l.fields.gameId === 'game-1'));
    assert.ok(w.logged('bilibili.link-ready').length === 1);
    // 第一次就连上：没有缺口。
    assert.equal(w.events('danmaku.gap-started').length, 0);
    assertCleanLogs(w.logs);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('弹幕写成事实后交给分诊，按 msg_id 去重；原文、zlib 与 brotli 批量都能收；其它命令只记事实', async () => {
  const fake = await fakePlatform();
  const config = fastConfig(fake);
  const w = await world([
    entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT }),
    entry('triage', 'audience-triage'),
  ]);
  try {
    w.listen();
    await waitFor(() => fake.authed.length === 1, '长连接认证');
    fake.push(dm(1));
    fake.push([dm(2), dm(3)], 'zlib');
    fake.push(
      [
        dm(4),
        command('SEND_GIFT', {
          open_id: 'viewer-9',
          uname: `${NICK}9`,
          uface: FACE,
          gift_id: 31036,
          gift_name: '小花花',
          gift_num: 3,
          price: 100,
          r_price: 100,
          paid: true,
          timestamp: 1_700_000_100,
          msg_id: 'gift-1',
        }),
      ],
      'brotli',
    );
    // 重连后平台可能重发：同一个 msg_id 只处理一次。
    fake.push([dm(1), dm(4)], 'zlib');
    fake.push(dm(5, { dm_type: 1, msg: '[打call]', emoji_img_url: 'https://i0.hdslb.com/e.png' }));
    fake.push([
      command('SUPER_CHAT', {
        open_id: 'viewer-10',
        uname: `${NICK}10`,
        uface: FACE,
        message_id: 77,
        message: `${TEXT}sc`,
        rmb: 30,
        timestamp: 1_700_000_200,
        start_time: 1,
        end_time: 2,
        msg_id: 'sc-1',
      }),
      command('SUPER_CHAT_DEL', { room_id: 1001, message_ids: [77], msg_id: 'scdel-1' }),
      command('GUARD', {
        user_info: { open_id: 'viewer-11', uname: `${NICK}11`, uface: FACE },
        guard_level: 3,
        guard_num: 1,
        guard_unit: '月',
        price: 198000,
        timestamp: 1_700_000_300,
        msg_id: 'guard-1',
      }),
      command('LIKE', {
        open_id: 'viewer-12',
        uname: `${NICK}12`,
        uface: FACE,
        like_text: `${NICK}12 点赞了`,
        like_count: 5,
        timestamp: 1_700_000_400,
        msg_id: 'like-1',
      }),
      command('LIVE_ROOM_ENTER', {
        open_id: 'viewer-13',
        uname: `${NICK}13`,
        uface: FACE,
        timestamp: 1,
        msg_id: 'enter-1',
      }),
      command('LIVE_START', {
        room_id: 1001,
        open_id: 'anchor',
        timestamp: 1_700_000_500,
        msg_id: 'start-1',
      }),
      command('LIVE_END', {
        room_id: 1001,
        open_id: 'anchor',
        timestamp: 1_700_000_600,
        msg_id: 'end-1',
      }),
      command('SOMETHING_NEW', { msg_id: 'x-1' }),
      dm(6, { msg_id: undefined }),
      dm(7),
    ]);
    await waitFor(() => w.received.length === 5, '五条普通弹幕交给订阅者');
    await waitFor(() => w.events('live.ended').length === 1, '最后一批消息处理完');

    assert.deepEqual(
      w.received.map((d) => d.id),
      ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-7'],
    );
    assert.deepEqual(w.received[0], {
      id: 'msg-1',
      viewer: 'viewer-1',
      nickname: `${NICK}1`,
      text: `${TEXT}1`,
    });

    const danmaku = w.events('danmaku.received');
    assert.equal(danmaku.length, 6, '五条普通弹幕与一条表情包弹幕，重发的不重复记');
    const one = danmaku[0]?.data as Record<string, unknown>;
    assert.equal(one.platform, 'bilibili');
    assert.equal(one.msgId, 'msg-1');
    assert.equal(one.openId, 'viewer-1');
    assert.equal(one.nickname, `${NICK}1`);
    assert.equal(one.text, `${TEXT}1`);
    assert.equal(one.platformTimestamp, 1_700_000_001);
    assert.equal(one.dmType, 0);
    assert.equal(one.delivered, true);
    assert.equal(typeof one.receivedAt, 'number');
    assert.ok(!JSON.stringify(danmaku).includes('FACEMARK'), '头像不存');
    const emoji = danmaku.find((e) => (e.data as { msgId: string }).msgId === 'msg-5')?.data as
      | { dmType: number; delivered: boolean }
      | undefined;
    assert.deepEqual(
      { dmType: emoji?.dmType, delivered: emoji?.delivered },
      { dmType: 1, delivered: false },
    );

    const data = (type: string) => w.events(type).map((e) => e.data as Record<string, unknown>);
    assert.deepEqual(
      data('gift.received').map(({ receivedAt: _, ...rest }) => rest),
      [
        {
          platform: 'bilibili',
          msgId: 'gift-1',
          platformTimestamp: 1_700_000_100,
          openId: 'viewer-9',
          giftId: 31036,
          giftName: '小花花',
          count: 3,
          unitPrice: 100,
          paid: true,
        },
      ],
    );
    assert.deepEqual(
      data('superchat.received').map(({ receivedAt: _, ...rest }) => rest),
      [
        {
          platform: 'bilibili',
          msgId: 'sc-1',
          platformTimestamp: 1_700_000_200,
          openId: 'viewer-10',
          superChatId: '77',
          rmb: 30,
        },
      ],
    );
    assert.deepEqual(data('superchat.deleted')[0]?.superChatIds, ['77']);
    assert.deepEqual(
      data('guard.bought').map(({ receivedAt: _, ...rest }) => rest),
      [
        {
          platform: 'bilibili',
          msgId: 'guard-1',
          platformTimestamp: 1_700_000_300,
          openId: 'viewer-11',
          guardLevel: 3,
          count: 1,
          unit: '月',
          price: 198000,
        },
      ],
    );
    assert.equal(data('like.received')[0]?.count, 5);
    assert.equal(data('live.started')[0]?.platformTimestamp, 1_700_000_500);
    assert.equal(data('live.ended')[0]?.platformTimestamp, 1_700_000_600);
    // SC 留言、点赞文案、进入房间的观众都不存。
    const all = JSON.stringify(w.store.events());
    assert.ok(!all.includes(`${TEXT}sc`));
    assert.ok(!all.includes('点赞了'));
    assert.ok(!all.includes('viewer-13'));

    assert.ok(
      w
        .logged('bilibili.unknown-command')
        .some((l) => l.fields.cmd === 'LIVE_OPEN_PLATFORM_SOMETHING_NEW'),
    );
    assert.equal(w.logged('bilibili.malformed').length, 1, '缺 msg_id 的弹幕不交出');
    // 分诊收到了弹幕。
    assert.ok(w.candidates().size > 0);
    assertCleanLogs(w.logs);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('停用时停心跳、关长连接并关闭场次；收到的计数写进日志', async () => {
  const fake = await fakePlatform();
  const config = fastConfig(fake, { heartbeatIntervalMs: 30, projectHeartbeatMs: 30 });
  const w = await world([entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT })]);
  try {
    await waitFor(() => fake.authed.length === 1, '长连接认证');
    fake.push(dm(1));
    await waitFor(() => w.events('danmaku.received').length === 1, '收到弹幕');
    await w.kernel.disable('danmaku');
    assert.equal(w.state('danmaku')?.state, 'disposed');
    const ends = fake.calls('end');
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0]?.body, { app_id: APP_ID, game_id: 'game-1' });
    assert.equal(ends[0]?.code, 0);
    assert.equal(fake.activeGame, undefined);
    await waitFor(() => fake.authed.length === 0, '长连接已关闭');
    const heartbeats = fake.calls('heartbeat').length;
    const beats = fake.packets.filter((p) => p.operation === Operation.Heartbeat).length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fake.calls('heartbeat').length, heartbeats, '项目心跳已停');
    assert.equal(fake.packets.filter((p) => p.operation === Operation.Heartbeat).length, beats);
    const stopped = w.logged('bilibili.stopped')[0];
    assert.deepEqual(stopped?.fields.counts, { danmaku: 1 });
    assert.ok(w.logged('bilibili.session-ended').some((l) => l.fields.gameId === 'game-1'));
    // 正常收着时停用不算缺口。
    assert.equal(w.events('danmaku.gap-started').length, 0);
    assertCleanLogs(w.logs);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('长连接地址逐个核对外发授权：未授予的主机、非本机的 ws:// 都跳过，只连授予了的', async () => {
  const fake = await fakePlatform({
    links: (f) => [
      f.wsUrl('/sub', 'localhost'),
      'wss://comet.example.com/sub',
      'ws://zj-cn-live-comet.chat.bilibili.com:2244/sub',
      'not a url',
      f.wsUrl('/sub'),
    ],
  });
  const w = await world([
    entry('danmaku', 'danmaku-bilibili', { config: fastConfig(fake), grant: GRANT }),
  ]);
  try {
    await waitFor(() => fake.authed.length === 1, '长连接认证');
    assert.deepEqual(
      fake.upgrades.map((u) => u.host),
      [`127.0.0.1:${fake.port}`],
    );
    const skipped = w.logged('bilibili.host-skipped').map((l) => [l.fields.host, l.fields.reason]);
    assert.deepEqual(skipped, [
      [`localhost:${fake.port}`, '未授予权限 net.egress:localhost'],
      ['comet.example.com', '未授予权限 net.egress:comet.example.com'],
      ['zj-cn-live-comet.chat.bilibili.com:2244', '须为 wss://（本机测试除外）'],
      ['?', '地址不合法'],
    ]);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('长连接地址全都未授予时不连接：关闭场次、记缺口，过一会儿再试；停用时缺口以未恢复结束', async () => {
  const fake = await fakePlatform({ links: (f) => [f.wsUrl('/sub', 'localhost')] });
  const config = fastConfig(fake, { blockedRetryMs: 200 });
  const w = await world([entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT })]);
  try {
    await waitFor(() => fake.calls('start').length >= 2, '过一会儿重新开启');
    assert.equal(fake.upgrades.length, 0);
    assert.ok(fake.calls('end').some((c) => c.body?.game_id === 'game-1' && c.code === 0));
    const gap = w.events('danmaku.gap-started');
    assert.equal(gap.length, 1);
    const reason = (gap[0]?.data as { reason?: string } | undefined)?.reason;
    assert.match(reason ?? '', /没有可连接的长连接地址/);
    // 此刻仍在缺口中：danmaku@1 的订阅者看得到。
    assert.equal(w.service(DanmakuService).gap?.()?.reason, reason);
    await w.kernel.disable('danmaku');
    const ended = w.events('danmaku.gap-ended').map((e) => e.data as Record<string, unknown>);
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.recovered, false);
    assert.equal(typeof ended[0]?.durationMs, 'number');
  } finally {
    await w.close();
    await fake.close();
  }
});

test('凭据缺失或配置不全时停在 FAILED 并说明原因，不连接任何端点；原因里不带凭据的值', async () => {
  const fake = await fakePlatform();
  const config = fastConfig(fake);
  const cases: Array<{
    secrets: Record<string, string>;
    config?: Record<string, unknown>;
    reason: RegExp;
  }> = [
    { secrets: {}, reason: /缺少凭据 bilibili（维护者用 pnpm secret set bilibili 录入/ },
    { secrets: { bilibili: SECRETS.bilibili }, reason: /缺少凭据 bilibili-code/ },
    { secrets: { ...SECRETS, bilibili: 'SECRETMARK{not json' }, reason: /凭据 bilibili 不是 JSON/ },
    {
      secrets: { ...SECRETS, bilibili: JSON.stringify({ accessKeyId: 'SECRETMARK' }) },
      reason: /缺少 accessKeyId 或 accessKeySecret/,
    },
    { secrets: SECRETS, config: { appId: 0 }, reason: /未配置项目 ID（appId）/ },
    {
      secrets: SECRETS,
      config: { endpoint: 'https://open.example.com' },
      reason: /接口基址未授予权限 net\.egress:open\.example\.com/,
    },
    {
      secrets: SECRETS,
      config: { endpoint: 'http://live-open.biliapi.com' },
      reason: /接口基址须为 https:\/\//,
    },
  ];
  try {
    for (const c of cases) {
      const w = await world(
        [
          entry('danmaku', 'danmaku-bilibili', {
            config: { ...config, ...c.config },
            grant: GRANT,
          }),
        ],
        c.secrets,
      );
      try {
        const state = w.state('danmaku');
        assert.equal(state?.state, 'failed', JSON.stringify(state));
        assert.match(state?.reason ?? '', c.reason);
        assert.ok(!(state?.reason ?? '').includes('SECRETMARK'));
        assert.ok(!JSON.stringify(w.logs).includes('SECRETMARK'));
        assert.ok(w.logged('bilibili.unavailable').length >= 1);
      } finally {
        await w.close();
      }
    }
    assert.equal(fake.requests.length, 0);
    assert.equal(fake.upgrades.length, 0);
  } finally {
    await fake.close();
  }
});

test('清单申请的权限未授予时停在 WAITING', async () => {
  const fake = await fakePlatform();
  const w = await world([
    entry('danmaku', 'danmaku-bilibili', {
      config: fastConfig(fake),
      grant: GRANT.filter((p) => p !== 'net.egress:*.chat.bilibili.com'),
    }),
  ]);
  try {
    const state = w.state('danmaku');
    assert.equal(state?.state, 'waiting');
    assert.match(state?.reason ?? '', /未授予权限 net\.egress:\*\.chat\.bilibili\.com/);
    assert.equal(fake.requests.length, 0);
  } finally {
    await w.close();
    await fake.close();
  }
});

test('遥测在场时每条交给分诊的弹幕开一个根 span，只记平台与消息编号；候选以它为父', async () => {
  const fake = await fakePlatform();
  const config = fastConfig(fake);
  const w = await world([
    entry('telemetry', 'telemetry-memory'),
    entry('danmaku', 'danmaku-bilibili', { config, grant: GRANT }),
    entry('triage', 'audience-triage'),
  ]);
  try {
    w.listen();
    await waitFor(() => fake.authed.length === 1, '长连接认证');
    fake.push([dm(1), dm(2)]);
    // 点赞只写事实，不开链路。
    fake.push(command('LIKE', { open_id: 'viewer-12', like_count: 5, msg_id: 'like-1' }));
    await waitFor(() => w.received.length === 2, '两条弹幕交给分诊');
    await new Promise((resolve) => setImmediate(resolve));
    const lines = w.service(TelemetryMemoryService).lines;
    const roots = parseLines(lines).spans.filter((s) => s.name === 'danmaku.receive');
    assert.deepEqual(
      roots.map((s) => s.attributes),
      [1, 2].map((n) => ({
        'bellis.danmaku.platform': 'bilibili',
        'bellis.danmaku.id': `msg-${n}`,
      })),
    );
    for (const [index, danmaku] of w.received.entries()) {
      const root = roots[index];
      assert.equal(danmaku.trace?.traceparent, `00-${root?.traceId}-${root?.spanId}-01`);
      assert.equal(typeof danmaku.trace?.originAt, 'number');
    }
    // 候选在第一条弹幕的 trace 里。
    for (const candidate of w.candidates().take(2)) {
      const root = roots.find((s) => s.attributes['bellis.danmaku.id'] === candidate.sources[0]);
      assert.equal(candidate.trace?.traceparent.slice(3, 35), root?.traceId);
    }
    const text = lines.join('\n');
    for (const marker of [NICK, TEXT, 'FACEMARK', 'viewer-1', 'viewer-2']) {
      assert.ok(!text.includes(marker), `遥测里出现了 ${marker}`);
    }
  } finally {
    await w.close();
    await fake.close();
  }
});
