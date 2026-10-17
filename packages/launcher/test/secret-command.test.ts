import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { OBS_SECRET, readObsSecret, SIM_OBS_SECRET } from '@bellis/config';
import { MemorySecretStore, SESSION_SECRET } from '@bellis/secret-store';
import {
  applyKeys,
  type Prompter,
  runSecretCommand,
  terminalPrompter,
} from '../src/secret-command.ts';

/** 按顺序给出预设的回答，并记下每次提问是否要求不回显。 */
function scripted(answers: string[]) {
  const asked: Array<{ question: string; hidden: boolean }> = [];
  const prompt: Prompter = {
    async ask(question, { hidden }) {
      asked.push({ question, hidden });
      const answer = answers.shift();
      if (answer === undefined) throw new Error('输入已结束');
      return answer;
    },
  };
  return { prompt, asked };
}

async function run(args: string[], store: MemorySecretStore, answers: string[] = []) {
  const { prompt, asked } = scripted(answers);
  const printed: string[] = [];
  const code = await runSecretCommand(args, store, {
    prompt,
    print: (line) => printed.push(line),
    cwd: process.cwd(),
    root: process.cwd(),
  });
  return { code, printed, asked };
}

test('写入普通凭据：两遍都不回显，输出里没有值', async () => {
  const store = new MemorySecretStore();
  const secret = 'sk-测试-12345';
  const result = await run(['set', 'tts.example'], store, [secret, secret]);
  assert.equal(result.code, 0);
  assert.equal(await store.get('tts.example'), secret);
  assert.deepEqual(
    result.asked.map((entry) => entry.hidden),
    [true, true],
  );
  assert.deepEqual(result.printed, ['已写入 tts.example']);

  const again = await run(['set', 'tts.example'], store, ['v2', 'v2']);
  assert.deepEqual(again.printed, ['已覆盖 tts.example']);
  assert.ok(!again.printed.join('\n').includes('v2'));
});

test('两遍不一致或为空时不写入', async () => {
  const store = new MemorySecretStore();
  const mismatch = await run(['set', 'a'], store, ['x', 'y']);
  assert.equal(mismatch.code, 1);
  assert.deepEqual(mismatch.printed, ['两次输入不一致，未写入']);
  const empty = await run(['set', 'a'], store, ['', '']);
  assert.equal(empty.code, 1);
  assert.deepEqual(await store.names(), []);
});

test('OBS 凭据：地址可见、可用缺省值，密码不回显，按格式校验', async () => {
  const store = new MemorySecretStore();
  const withDefault = await run(['set', OBS_SECRET], store, ['', 'pw', 'pw']);
  assert.equal(withDefault.code, 0);
  assert.deepEqual(
    withDefault.asked.map((entry) => entry.hidden),
    [false, true, true],
  );
  assert.deepEqual(await readObsSecret(store, OBS_SECRET), {
    url: 'ws://127.0.0.1:4455',
    password: 'pw',
  });

  await run(['set', OBS_SECRET], store, ['ws://127.0.0.1:4466', '', '']);
  assert.deepEqual(await readObsSecret(store, OBS_SECRET), { url: 'ws://127.0.0.1:4466' });

  const invalid = await run(['set', OBS_SECRET], store, ['http://x', 'pw', 'pw']);
  assert.equal(invalid.code, 1);
  assert.ok(!invalid.printed.join('\n').includes('pw'));
  assert.deepEqual(await readObsSecret(store, OBS_SECRET), { url: 'ws://127.0.0.1:4466' });
});

test('启动器管理的条目不能手工修改；列出时只显示名字', async () => {
  const store = new MemorySecretStore();
  await store.set(SESSION_SECRET, 'session-value');
  await store.set('b', 'b-value');
  for (const name of [SESSION_SECRET, SIM_OBS_SECRET]) {
    assert.equal((await run(['set', name], store, ['x', 'x'])).code, 1);
    assert.equal((await run(['delete', name], store)).code, 1);
  }
  const listed = await run(['list'], store);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.printed, ['b', 'session（由启动器管理）']);
  assert.ok(!listed.printed.join('\n').includes('value'));
});

test('删除与用法错误', async () => {
  const store = new MemorySecretStore();
  await store.set('a', 'v');
  assert.deepEqual((await run(['delete', 'a'], store)).printed, ['已删除 a']);
  assert.deepEqual((await run(['delete', 'a'], store)).printed, ['没有 a']);
  assert.deepEqual((await run(['list'], new MemorySecretStore())).printed, ['（没有凭据）']);
  for (const args of [[], ['set'], ['get', 'a'], ['set', 'a', 'extra'], ['list', 'a']]) {
    assert.equal((await run(args, store)).code, 2);
  }
  assert.equal((await run(['set', '../x'], store)).code, 2);
});

test('不回显输入的按键处理：退格、粘贴、转义序列、取消', () => {
  assert.deepEqual(applyKeys('', 'ab'), { kind: 'more', buffer: 'ab' });
  assert.deepEqual(applyKeys('ab', '\u007f'), { kind: 'more', buffer: 'a' });
  assert.deepEqual(applyKeys('密码', '\u0008'), { kind: 'more', buffer: '密' });
  assert.deepEqual(applyKeys('😀', '\u0008'), { kind: 'more', buffer: '' });
  assert.deepEqual(applyKeys('', 'x\u001b[Ay\u001b[3~z\r'), { kind: 'done', value: 'xyz' });
  assert.deepEqual(applyKeys('', 'pasted-secret\r\n'), { kind: 'done', value: 'pasted-secret' });
  assert.deepEqual(applyKeys('abc', '\u0003'), { kind: 'cancelled' });
  assert.deepEqual(applyKeys('', '\t'), { kind: 'more', buffer: '' });
});

test('stdin 不是终端时按行读取', async () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  const prompter = terminalPrompter(input, output);
  (input as unknown as PassThrough).end('first\nsecond\n');
  assert.equal(await prompter.ask('? ', { hidden: true }), 'first');
  assert.equal(await prompter.ask('? ', { hidden: false }), 'second');
  await assert.rejects(prompter.ask('? ', { hidden: true }), /输入已结束/);
  prompter.close();
});
