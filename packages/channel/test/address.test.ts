import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  ChannelError,
  createChannelPath,
  createSessionKey,
  decodeSessionKey,
  encodeSessionKey,
} from '../src/index.ts';

const isAddressInvalid = (error: unknown) =>
  error instanceof ChannelError && error.code === 'address-invalid';

test('Windows 上是带 128 位随机数的命名管道', () => {
  const path = createChannelPath('s1', 'win32');
  assert.match(path, /^\\\\\.\\pipe\\bellis-s1-[a-z2-7]{26}$/);
  assert.notEqual(createChannelPath('s1', 'win32'), path);
});

test('其它平台是系统临时目录下的 UDS', () => {
  const path = createChannelPath('s1', 'linux');
  assert.ok(path.startsWith(tmpdir()));
  assert.match(path, /bellis-s1-[a-z2-7]{26}\.sock$/);
});

test('会话编号不合法时拒绝', () => {
  assert.throws(() => createChannelPath('../x'), isAddressInvalid);
  assert.throws(() => createChannelPath(''), isAddressInvalid);
  assert.throws(() => createChannelPath('a'.repeat(17)), isAddressInvalid);
});

test('会话密钥可以编码传递，长度或格式不对时拒绝', () => {
  const key = createSessionKey();
  assert.deepEqual(decodeSessionKey(encodeSessionKey(key)), key);
  assert.throws(() => decodeSessionKey(encodeSessionKey(key.subarray(1))), isAddressInvalid);
  assert.throws(() => decodeSessionKey(`${encodeSessionKey(key)}=`), isAddressInvalid);
  assert.throws(() => decodeSessionKey('not a key'), isAddressInvalid);
});
