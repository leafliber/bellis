import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { INTENT_OUTPUT, LlmError, type LlmMessage } from '@bellis/director';
import { systemClock } from '@bellis/kernel';
import {
  ChatClient,
  type ChatLimits,
  type ChatObserver,
  type ChatSettings,
  requestBody,
} from '../src/index.ts';
import { FakeChat, respond, status } from './fake-chat.ts';
import {
  ARK_MODEL,
  arkReasoningStream,
  DONE,
  event,
  finishStream,
  INTENT,
  messyStream,
  midStreamError,
  openAiToolStream,
  REASONING_MARK,
  truncatedStream,
} from './fixtures.ts';

/** 测试用的假 API Key：带可辨认的标记，核对它不出现在任何错误与回调里。 */
const KEY = 'FAKE-ARK-KEY-7c1e0b9a4d2f';

const messages: LlmMessage[] = [
  { role: 'system', content: '你是主播。' },
  { role: 'user', content: '有新的候选弹幕。' },
];
const request = { messages, output: INTENT_OUTPUT };

const limits: ChatLimits = {
  connectTimeoutMs: 2000,
  firstChunkTimeoutMs: 2000,
  stallTimeoutMs: 2000,
  maxEventChars: 65_536,
  maxOutputChars: 8192,
};

let fake: FakeChat;
before(async () => {
  fake = await FakeChat.start();
});
after(async () => {
  await fake.close();
});

function client(settings: Partial<ChatSettings> = {}, overrides: Partial<ChatLimits> = {}) {
  return new ChatClient({
    settings: { endpoint: fake.url, model: ARK_MODEL, outputMode: 'json_schema', ...settings },
    limits: { ...limits, ...overrides },
    apiKey: KEY,
    clock: systemClock(),
  });
}

/** 记下观察者收到的全部回调（按顺序）。 */
function observed() {
  const calls: Array<[string, unknown]> = [];
  const observer: ChatObserver = {
    onFirstChunk: () => calls.push(['firstChunk', null]),
    onFirstOutput: () => calls.push(['firstOutput', null]),
    onUsage: (usage) => calls.push(['usage', usage]),
    onOutput: (delta) => calls.push(['output', delta]),
  };
  return { calls, observer };
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LlmError, String(error));
    assert.ok(!error.message.includes(KEY), '错误说明不含 API Key');
    assert.ok(!JSON.stringify(error).includes(KEY));
    assert.ok(!error.message.includes(REASONING_MARK), '错误说明不含思考内容');
    return error;
  }
  assert.fail('应当失败');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('方舟流式：思考内容丢弃，只返回正文；首块、首个正文块、用量与应答型号；请求头与请求体', async () => {
  fake.script = respond(arkReasoningStream());
  const { calls, observer } = observed();
  const result = await client({ reasoningEffort: 'low' }).complete(
    request,
    new AbortController().signal,
    observer,
  );
  assert.equal(result.output, INTENT);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.responseModel, ARK_MODEL);
  assert.deepEqual(result.usage, {
    inputTokens: 812,
    outputTokens: 64,
    reasoningOutputTokens: 41,
    responseModel: ARK_MODEL,
  });
  // 3 个思考块、正文块、结束块与用量块；[DONE] 不算。
  assert.equal(result.chunks, 3 + Math.ceil(INTENT.length / 7) + 2);
  assert.deepEqual(calls[0], ['firstChunk', null]);
  assert.deepEqual(calls[1], ['firstOutput', null]);
  assert.equal(calls.filter(([kind]) => kind === 'firstOutput').length, 1);
  assert.equal(
    calls
      .filter(([kind]) => kind === 'output')
      .map(([, delta]) => delta)
      .join(''),
    INTENT,
  );
  assert.deepEqual(calls.at(-1), ['usage', result.usage]);
  assert.ok(!JSON.stringify({ result, calls }).includes(REASONING_MARK), '思考内容一律丢弃');

  const sent = fake.requests.at(-1);
  assert.equal(sent?.method, 'POST');
  assert.equal(sent?.path, '/api/v3/chat/completions');
  assert.equal(sent?.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent?.headers.accept, 'text/event-stream');
  assert.match(String(sent?.headers['content-type']), /^application\/json/);
  assert.equal(sent?.headers.traceparent, undefined, 'traceparent 不发给模型服务');
  assert.deepEqual(
    sent?.body,
    requestBody(
      { endpoint: fake.url, model: ARK_MODEL, outputMode: 'json_schema', reasoningEffort: 'low' },
      request,
    ),
  );
});

test('请求体：按输出方式、思考开关与档位成形，没有配置的字段不发', () => {
  const base: ChatSettings = { endpoint: 'https://x.test/v1', model: 'm', outputMode: 'prompt' };
  const common = {
    model: 'm',
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  assert.deepEqual(requestBody(base, request), common);
  const { name, description, schema } = INTENT_OUTPUT;
  assert.deepEqual(requestBody({ ...base, outputMode: 'json_schema' }, request), {
    ...common,
    response_format: {
      type: 'json_schema',
      json_schema: { name, description, schema, strict: true },
    },
  });
  assert.deepEqual(requestBody({ ...base, outputMode: 'json_object' }, request), {
    ...common,
    response_format: { type: 'json_object' },
  });
  assert.deepEqual(requestBody({ ...base, outputMode: 'tool' }, request), {
    ...common,
    tools: [{ type: 'function', function: { name, description, parameters: schema } }],
    tool_choice: { type: 'function', function: { name } },
  });
  assert.deepEqual(requestBody({ ...base, thinking: 'disabled' }, request), {
    ...common,
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(
    requestBody(
      { ...base, thinking: 'enabled', reasoningEffort: 'low', temperature: 0.7, maxTokens: 512 },
      request,
    ),
    {
      ...common,
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
      temperature: 0.7,
      max_tokens: 512,
    },
  );
  // 显式给 undefined 也不发。
  const body = requestBody(
    { ...base, thinking: undefined, reasoningEffort: undefined, temperature: undefined },
    request,
  );
  assert.deepEqual(Object.keys(body).sort(), Object.keys(common).sort());
});

test('函数调用：参数增量拼接；没有调用、调用了别的函数或多个函数都是协议错误', async () => {
  fake.script = respond(openAiToolStream());
  const { calls, observer } = observed();
  const result = await client({ outputMode: 'tool' }).complete(
    request,
    new AbortController().signal,
    observer,
  );
  assert.equal(result.output, INTENT);
  assert.deepEqual(result.usage, {
    inputTokens: 640,
    outputTokens: 25,
    reasoningOutputTokens: 0,
    responseModel: 'gpt-test-2026-01-01',
  });
  assert.equal(calls.filter(([kind]) => kind === 'firstOutput').length, 1);

  fake.script = respond(openAiToolStream({ finishReason: 'tool_calls' }));
  assert.equal(
    (await client({ outputMode: 'tool' }).complete(request, new AbortController().signal)).output,
    INTENT,
  );
  for (const [stream, words] of [
    [openAiToolStream({ name: 'other_tool' }), '模型调用的不是指定的函数'],
    [openAiToolStream({ extraCall: true }), '模型调用了 2 个函数'],
    [arkReasoningStream(), '模型没有调用指定的函数'],
  ] as const) {
    fake.script = respond(stream);
    const error = await failure(
      client({ outputMode: 'tool' }).complete(request, new AbortController().signal),
    );
    assert.equal(error.kind, 'protocol');
    assert.equal(error.message, words);
  }
});

test('杂乱但合规的流：保活注释、多行 data、CRLF 与 CR、最后的 [DONE] 没有空行', async () => {
  fake.script = respond(messyStream(), 5);
  const result = await client({ outputMode: 'prompt' }).complete(
    request,
    new AbortController().signal,
  );
  assert.equal(result.output, INTENT);
  assert.equal(result.comments, 3);
  assert.equal(result.usage?.reasoningOutputTokens, 41);
});

test('按字节切碎（拆开多字节字符与 CRLF）照样解析', async () => {
  const bytes = Buffer.from(arkReasoningStream().join('').replaceAll('\n', '\r\n'), 'utf8');
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 3) parts.push(bytes.subarray(i, i + 3));
  fake.script = respond(parts);
  const result = await client().complete(request, new AbortController().signal);
  assert.equal(result.output, INTENT);
});

test('流中途的错误对象按类归类；数据块不是 JSON、没有结束原因、结束原因不是 stop', async () => {
  const cases: Array<[string[], string]> = [
    [
      midStreamError({
        code: 'RateLimitExceeded.EndpointTPMExceeded',
        message: 'Too many tokens',
        type: 'TooManyRequests',
      }),
      'rate_limit',
    ],
    [
      midStreamError({ code: 'InternalServiceError', message: 'oops', type: 'InternalError' }),
      'server',
    ],
    [midStreamError({ code: 'AuthenticationError', message: `bad key ${KEY}` }), 'auth'],
    [midStreamError({ code: 'InvalidParameter', message: 'response_format' }), 'request'],
    [midStreamError({ status: 503, message: 'busy' }), 'server'],
    [['event: error\ndata: {"code":"ServerOverloaded","message":"busy"}\n\n'], 'server'],
    [[event('{"choices":[{"delta":{"content":"x"'), DONE], 'protocol'],
    [[event('[1,2]'), DONE], 'protocol'],
    [truncatedStream(), 'protocol'],
    [[...truncatedStream(), DONE], 'protocol'],
    [finishStream('length'), 'incomplete'],
    [finishStream('content_filter'), 'incomplete'],
  ];
  for (const [stream, kind] of cases) {
    fake.script = respond(stream);
    const error = await failure(client().complete(request, new AbortController().signal));
    assert.equal(error.kind, kind, `${stream.join('').slice(0, 80)} → ${error.message}`);
  }
  fake.script = respond(midStreamError({ code: 'AuthenticationError', message: `bad key ${KEY}` }));
  const error = await failure(client().complete(request, new AbortController().signal));
  assert.equal(error.message, '流中途出错（鉴权失败）：AuthenticationError：bad key ***');
  assert.equal(error.code, 'AuthenticationError');
});

test('单个事件与输出总长有上限', async () => {
  fake.script = respond(arkReasoningStream());
  const long = await failure(
    client({}, { maxOutputChars: 20 }).complete(request, new AbortController().signal),
  );
  assert.equal(long.kind, 'protocol');
  assert.equal(long.message, '输出超过 20 个字符');
  fake.script = respond([event({ choices: [{ index: 0, delta: { content: 'x'.repeat(3000) } }] })]);
  const big = await failure(
    client({}, { maxEventChars: 1024 }).complete(request, new AbortController().signal),
  );
  assert.equal(big.kind, 'protocol');
  assert.match(big.message, /超过 1024 个字符/);
});

test('HTTP 错误：鉴权、限流、服务端、请求被拒；说明只留截短的摘录并抹掉 API Key', async () => {
  const echo = (code: number, error: Record<string, unknown>) =>
    status(code, JSON.stringify({ error }));
  const cases: Array<[ReturnType<typeof status>, string, number]> = [
    [
      echo(401, { code: 'AuthenticationError', message: `The API key ${KEY} is invalid` }),
      'auth',
      401,
    ],
    [echo(403, { code: 'AccessDenied', message: 'model not activated' }), 'auth', 403],
    [echo(429, { code: 'RateLimitExceeded', message: 'slow down' }), 'rate_limit', 429],
    [echo(500, { code: 'InternalServiceError', message: 'oops' }), 'server', 500],
    [status(503, 'Service Unavailable', 'text/plain'), 'server', 503],
    [
      echo(400, { code: 'InvalidParameter', message: 'thinking.type disabled not supported' }),
      'request',
      400,
    ],
    [
      echo(404, { code: 'InvalidEndpointOrModel.NotFound', message: 'no such model' }),
      'request',
      404,
    ],
  ];
  for (const [script, kind, code] of cases) {
    fake.script = script;
    const error = await failure(client().complete(request, new AbortController().signal));
    assert.equal(error.kind, kind);
    assert.equal(error.status, code);
  }
  fake.script = echo(401, {
    code: 'AuthenticationError',
    message: `The API key ${KEY} is invalid`,
  });
  const auth = await failure(client().complete(request, new AbortController().signal));
  assert.equal(
    auth.message,
    '鉴权失败：HTTP 401（AuthenticationError）：The API key *** is invalid',
  );
  // 返回体很长、还把鉴权头原样带回来：只留截短的摘录，不含 API Key。
  fake.script = (exchange) => {
    const header = String(exchange.request.headers.authorization);
    exchange.res
      .writeHead(400, { 'content-type': 'text/html' })
      .end(`<html>${header} ${'很长的说明'.repeat(500)}</html>`);
  };
  const long = await failure(client().complete(request, new AbortController().signal));
  assert.equal(long.kind, 'request');
  assert.ok(long.message.length < 260, String(long.message.length));
  assert.match(long.message, /Bearer \*\*\*/);
});

test('200 但不是 SSE：协议错误', async () => {
  fake.script = status(200, JSON.stringify({ error: { code: 'Weird', message: 'not a stream' } }));
  const error = await failure(client().complete(request, new AbortController().signal));
  assert.equal(error.kind, 'protocol');
  assert.equal(
    error.message,
    '返回的不是 SSE（content-type：application/json）：Weird：not a stream',
  );
});

test('超时：响应头、首块（保活注释不算）、块间停顿；超时即断开', async () => {
  const short = { connectTimeoutMs: 150, firstChunkTimeoutMs: 150, stallTimeoutMs: 150 };
  const before = fake.disconnects;
  fake.script = () => {};
  const connect = await failure(client({}, short).complete(request, new AbortController().signal));
  assert.equal(connect.kind, 'timeout');
  assert.match(connect.message, /响应头未在 150ms 内到达/);

  fake.script = async (exchange) => {
    await exchange.stream([': keep-alive\n\n', ': keep-alive\n\n', ': keep-alive\n\n'], 60);
  };
  const first = await failure(client({}, short).complete(request, new AbortController().signal));
  assert.equal(first.kind, 'timeout');
  assert.match(first.message, /首块未在 150ms 内到达/);

  fake.script = async (exchange) => {
    await exchange.stream(arkReasoningStream().slice(0, 2));
  };
  const { calls, observer } = observed();
  const stall = await failure(
    client({}, short).complete(request, new AbortController().signal, observer),
  );
  assert.equal(stall.kind, 'timeout');
  assert.match(stall.message, /下一块未在 150ms 内到达/);
  assert.deepEqual(calls, [['firstChunk', null]]);
  await fake.waitDisconnect(before + 3);
});

test('取消：中止信号一到即断开，以 aborted 结束，之后不再有回调；已取消的不发请求', async () => {
  const stream = arkReasoningStream();
  fake.script = respond(stream, 40);
  const controller = new AbortController();
  const { calls, observer } = observed();
  const before = fake.disconnects;
  let aborted = 0;
  const done = client().complete(request, controller.signal, {
    ...observer,
    onFirstOutput: () => {
      observer.onFirstOutput?.();
      aborted = Date.now();
      controller.abort();
    },
  });
  const error = await failure(done);
  assert.equal(error.kind, 'aborted');
  assert.ok(Date.now() - aborted < 100, '中止后立即结束');
  const seen = calls.length;
  await fake.waitDisconnect(before + 1);
  await sleep(200);
  assert.equal(calls.length, seen, '取消之后不再有回调');
  assert.ok(fake.writesAfterClose > 0, '服务端还想写，但连接已断开');
  assert.ok(!calls.some(([kind]) => kind === 'usage'));

  const requests = fake.requests.length;
  const gone = new AbortController();
  gone.abort();
  assert.equal((await failure(client().complete(request, gone.signal))).kind, 'aborted');
  assert.equal(fake.requests.length, requests, '已取消的不发请求');

  // 还没收到响应头时取消。
  fake.script = () => {};
  const early = new AbortController();
  setTimeout(() => early.abort(), 50);
  assert.equal((await failure(client().complete(request, early.signal))).kind, 'aborted');
});

test('连不上：network', async () => {
  const closed = await FakeChat.start();
  const url = closed.url;
  await closed.close();
  const error = await failure(
    new ChatClient({
      settings: { endpoint: url, model: 'm', outputMode: 'prompt' },
      limits,
      apiKey: KEY,
      clock: systemClock(),
    }).complete(request, new AbortController().signal),
  );
  assert.equal(error.kind, 'network');
});
