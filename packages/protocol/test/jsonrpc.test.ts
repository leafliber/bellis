import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Compile } from 'typebox/compile';
import { RpcFailure, RpcMessage, RpcNotification, RpcRequest } from '../src/index.ts';

const request = Compile(RpcRequest);
const notification = Compile(RpcNotification);
const failure = Compile(RpcFailure);
const message = Compile(RpcMessage);

const method = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}(\.[a-z][a-z0-9_]{0,8}){1,2}$/);
const id = fc.oneof(fc.string({ minLength: 1, maxLength: 128 }), fc.integer());
const params = fc.dictionary(fc.string(), fc.jsonValue());

test('合法请求与通知通过校验', () => {
  fc.assert(
    fc.property(id, method, params, (id, method, params) => {
      assert.ok(request.Check({ jsonrpc: '2.0', id, method, params }));
      assert.ok(notification.Check({ jsonrpc: '2.0', method, params }));
      assert.ok(message.Check({ jsonrpc: '2.0', id, method }));
    }),
  );
});

test('带 id 的消息不会被当成通知', () => {
  assert.equal(notification.Check({ jsonrpc: '2.0', id: 1, method: 'speech.request' }), false);
});

test('拒绝多余字段、按位置传参、错误版本与非法方法名', () => {
  const base = { jsonrpc: '2.0', id: 1, method: 'speech.request' };
  assert.equal(request.Check({ ...base, extra: true }), false);
  assert.equal(request.Check({ ...base, params: [1, 2] }), false);
  assert.equal(request.Check({ ...base, jsonrpc: '1.0' }), false);
  assert.equal(request.Check({ ...base, method: 'Speech.Request' }), false);
  assert.equal(request.Check({ ...base, method: '' }), false);
  assert.equal(request.Check({ ...base, method: 'speech' }), false);
  assert.equal(request.Check({ ...base, id: Number.MAX_SAFE_INTEGER + 2 }), false);
  assert.equal(request.Check({ ...base, id: 1.5 }), false);
});

test('无法解析请求时的失败响应允许 id 为 null', () => {
  const error = { code: -32700, message: 'Parse error' };
  assert.ok(failure.Check({ jsonrpc: '2.0', id: null, error }));
  assert.equal(failure.Check({ jsonrpc: '2.0', error }), false);
});
