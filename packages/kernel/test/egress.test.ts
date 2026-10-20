import assert from 'node:assert/strict';
import { test } from 'node:test';
import { egressAllowed, egressPermission, resolveProfile } from '../src/index.ts';

const grant = (...hosts: string[]) => new Set(hosts.map(egressPermission));

test('外发权限名', () => {
  assert.equal(egressPermission('api.minimax.cn'), 'net.egress:api.minimax.cn');
  assert.equal(egressPermission('*.chat.bilibili.com'), 'net.egress:*.chat.bilibili.com');
});

test('精确匹配：只匹配同一个主机', () => {
  const permissions = grant('live-open.biliapi.com', '127.0.0.1', '[::1]');
  assert.equal(egressAllowed('live-open.biliapi.com', permissions), true);
  assert.equal(egressAllowed('127.0.0.1', permissions), true);
  assert.equal(egressAllowed('[::1]', permissions), true);
  assert.equal(egressAllowed('a.live-open.biliapi.com', permissions), false);
  assert.equal(egressAllowed('biliapi.com', permissions), false);
  assert.equal(egressAllowed('live-open.biliapi.com.evil.example', permissions), false);
  assert.equal(egressAllowed('127.0.0.2', permissions), false);
});

test('子域名通配：匹配任意层级的子域名，不匹配域名本身', () => {
  const permissions = grant('*.chat.bilibili.com');
  assert.equal(egressAllowed('zj-cn-live-comet.chat.bilibili.com', permissions), true);
  assert.equal(egressAllowed('a.b.chat.bilibili.com', permissions), true);
  assert.equal(egressAllowed('chat.bilibili.com', permissions), false);
  assert.equal(egressAllowed('bilibili.com', permissions), false);
  assert.equal(egressAllowed('xchat.bilibili.com', permissions), false);
  assert.equal(egressAllowed('a.chat.bilibili.com.evil.example', permissions), false);
  assert.equal(egressAllowed('.chat.bilibili.com', permissions), false);
  assert.equal(egressAllowed('a..chat.bilibili.com', permissions), false);
});

test('`*` 只在最前面、后跟点时表示通配，其它写法按字面比较', () => {
  for (const pattern of ['a.*.bilibili.com', 'chat.*', '*', '*bilibili.com', '**.bilibili.com']) {
    const permissions = grant(pattern);
    for (const host of ['a.chat.bilibili.com', 'chat.bilibili.com', 'x.bilibili.com']) {
      assert.equal(egressAllowed(host, permissions), false, `${pattern} 不应匹配 ${host}`);
    }
  }
  // 主机名本身带 `*` 时一律不匹配，即使权限按字面写了同样的串。
  assert.equal(egressAllowed('*.chat.bilibili.com', grant('*.chat.bilibili.com')), false);
  assert.equal(egressAllowed('*', grant('*')), false);
});

test('主机名不分大小写，末尾的点不影响比较', () => {
  assert.equal(egressAllowed('API.MiniMax.cn', grant('api.minimax.cn')), true);
  assert.equal(egressAllowed('api.minimax.cn', grant('API.MINIMAX.CN')), true);
  assert.equal(egressAllowed('api.minimax.cn.', grant('api.minimax.cn')), true);
  assert.equal(egressAllowed('api.minimax.cn', grant('api.minimax.cn.')), true);
  assert.equal(egressAllowed('A.Chat.Bilibili.COM.', grant('*.chat.bilibili.com')), true);
  assert.equal(egressAllowed('a.chat.bilibili.com', grant('*.CHAT.bilibili.com.')), true);
  assert.equal(egressAllowed('chat.bilibili.com.', grant('*.chat.bilibili.com')), false);
});

test('profile 接受外发权限的子域名通配；其它位置或其它权限里的 `*` 不合法', () => {
  const profile = (grant: string[]) => ({
    name: 'p',
    packs: [{ name: 'a', entries: [{ id: 'x', plugin: 'x', grant }] }],
  });
  const resolved = resolveProfile(
    profile(['net.egress:*.chat.bilibili.com', 'net.egress:live-open.biliapi.com']),
  );
  assert.deepEqual(resolved[0]?.grant, [
    'net.egress:*.chat.bilibili.com',
    'net.egress:live-open.biliapi.com',
  ]);
  for (const bad of ['net.egress:*', 'net.egress:a.*.com', 'net.egress:**.com', 'secret:*.x']) {
    assert.throws(() => resolveProfile(profile([bad])), /profile 不合法/, bad);
  }
});

test('只看外发权限：其它权限与空主机名都不匹配', () => {
  const permissions = new Set(['secret:api.minimax.cn', 'api.minimax.cn', 'obs.control']);
  assert.equal(egressAllowed('api.minimax.cn', permissions), false);
  assert.equal(egressAllowed('', grant('')), false);
  assert.equal(egressAllowed('.', grant('.')), false);
  assert.equal(egressAllowed('api.minimax.cn', []), false);
});
