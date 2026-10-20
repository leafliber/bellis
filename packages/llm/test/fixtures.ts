/**
 * 录制风格的 SSE 夹具：按火山方舟与 OpenAI 的 Chat Completions 流式格式手写（字段与顺序照官方文档的示例），
 * 不含真实模型输出与观众数据。每个夹具是一串“写到连接上的片段”，测试按需再切碎。
 */

/** 模型给的意图（正文或函数参数拼起来就是它）。 */
export const INTENT = '{"action":"speak","replyTo":"c-d1","text":"欢迎来到直播间！"}';

/** 思考内容：一律丢弃，测试核对它没有出现在返回值、日志、错误与回调里。 */
export const REASONING = ['观众在打招呼，', '思考标记-不应外泄', '，我应该热情回应。'];
export const REASONING_MARK = '思考标记-不应外泄';

export const ARK_MODEL = 'glm-5-3-flash-260828';

const ark = {
  created: 1761000000,
  id: '0217610000000001f2e3d4c5b6a7980123456789abcdef0123456',
  model: ARK_MODEL,
  service_tier: 'default',
  object: 'chat.completion.chunk',
};

const openai = {
  id: 'chatcmpl-0000000000000000000000000001',
  object: 'chat.completion.chunk',
  created: 1761000000,
  model: 'gpt-test-2026-01-01',
  system_fingerprint: 'fp_0000000000',
};

/** 把字符串按 `size` 个字符切开。 */
export function pieces(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** 一个 `data:` 事件（单行），以空行结束。 */
export const event = (value: unknown, eol = '\n') =>
  `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${eol}${eol}`;

export const DONE = 'data: [DONE]\n\n';

const arkChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  choices: [{ delta, index: 0, ...extra }],
  ...ark,
  usage: null,
});

export const ARK_USAGE = {
  completion_tokens: 64,
  prompt_tokens: 812,
  total_tokens: 876,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 41 },
};

/** 方舟：先流式出思考（reasoning_content），再出正文；结束块之后是用量块（choices 为空），最后 [DONE]。 */
export function arkReasoningStream(output = INTENT): string[] {
  return [
    event(arkChunk({ content: '', reasoning_content: REASONING[0], role: 'assistant' })),
    ...REASONING.slice(1).map((r) => event(arkChunk({ content: '', reasoning_content: r }))),
    ...pieces(output, 7).map((p) => event(arkChunk({ content: p, role: 'assistant' }))),
    event(arkChunk({ content: '', role: 'assistant' }, { finish_reason: 'stop' })),
    event({ choices: [], ...ark, usage: ARK_USAGE }),
    DONE,
  ];
}

/** OpenAI：指定函数时的流式函数调用，参数分多块拼接；`finishReason` 缺省为 `stop`（指定函数时 OpenAI 给 stop）。 */
export function openAiToolStream(
  options: { name?: string; finishReason?: string; extraCall?: boolean } = {},
): string[] {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    ...openai,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    usage: null,
  });
  const out = [
    event(
      chunk({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            index: 0,
            id: 'call_0000000000000000000001',
            type: 'function',
            function: { name: options.name ?? 'director_action', arguments: '' },
          },
        ],
        refusal: null,
      }),
    ),
    ...pieces(INTENT, 5).map((p) =>
      event(chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] })),
    ),
  ];
  if (options.extraCall) {
    out.push(
      event(
        chunk({
          tool_calls: [
            {
              index: 1,
              id: 'call_0000000000000000000002',
              type: 'function',
              function: { name: 'director_action', arguments: '{}' },
            },
          ],
        }),
      ),
    );
  }
  out.push(
    event(chunk({}, options.finishReason ?? 'stop')),
    event({
      ...openai,
      choices: [],
      usage: {
        prompt_tokens: 640,
        completion_tokens: 25,
        total_tokens: 665,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    DONE,
  );
  return out;
}

/**
 * 杂乱但合规的写法：CRLF 与单独的 CR 换行、保活注释、`event`/`id`/`retry` 字段、冒号后不带空格、
 * 一个 JSON 拆成两行 data、最后的 [DONE] 后面没有空行。
 */
export function messyStream(): string[] {
  const [head, tail] = [INTENT.slice(0, 20), INTENT.slice(20)];
  const first = JSON.stringify(arkChunk({ content: head, role: 'assistant' }));
  const cut = first.indexOf('"index"');
  return [
    ': keep-alive\r\n\r\n',
    'retry: 3000\r\nid: 1\r\nevent: message\r\n',
    // 一个 JSON 拆成两行 data：以 LF 连接，仍是合法 JSON。
    `data: ${first.slice(0, cut)}\r\ndata: ${first.slice(cut)}\r\n\r\n`,
    ':\r\n',
    `data:${JSON.stringify(arkChunk({ content: tail }))}\r\r`,
    ': ping\n\n',
    `data: ${JSON.stringify(arkChunk({ content: '' }, { finish_reason: 'stop' }))}\n\n`,
    `data: ${JSON.stringify({ choices: [], ...ark, usage: ARK_USAGE })}\r\n\r\n`,
    'data: [DONE]',
  ];
}

/** 流中途的错误对象（方舟与 OpenAI 都用 `{"error": {...}}`）。 */
export function midStreamError(error: Record<string, unknown>): string[] {
  return [
    event(arkChunk({ content: '', reasoning_content: '嗯', role: 'assistant' })),
    event(arkChunk({ content: '{"action":' })),
    event({ error }),
  ];
}

/** 正文出完但没有结束原因就断开。 */
export function truncatedStream(): string[] {
  return [
    event(arkChunk({ content: '', role: 'assistant' })),
    ...pieces(INTENT, 9).map((p) => event(arkChunk({ content: p }))),
  ];
}

/** 结束原因不是 stop：例如长度上限截断。 */
export function finishStream(reason: string): string[] {
  return [
    event(arkChunk({ content: INTENT.slice(0, 30), role: 'assistant' })),
    event(arkChunk({ content: '' }, { finish_reason: reason })),
    DONE,
  ];
}
