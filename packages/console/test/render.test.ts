import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 页面脚本（page/console.js）在最小的假 DOM 上跑：登录、轮询一次状态、渲染。只为核对显示，不模拟浏览器的其余行为；
 * 定时器不真正排上（轮询只跑一次）。
 */
class FakeElement {
  textContent = '';
  className = '';
  hidden = false;
  value = '';
  readonly dataset: Record<string, string> = {};
  readonly classList = new Set<string>();
  children: FakeElement[] = [];
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
    const set = this.classList;
    Object.assign(set, {
      toggle: (name: string, on?: boolean) => {
        if (on ?? !set.has(name)) set.add(name);
        else set.delete(name);
      },
      remove: (name: string) => set.delete(name),
      contains: (name: string) => set.has(name),
    });
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = [...nodes];
  }
  remove() {}
  setAttribute() {}
  addEventListener() {}
}

async function renderPage(status: Record<string, unknown>) {
  const elements = new Map<string, FakeElement>();
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(
    ['document', 'location', 'history', 'window', 'fetch', 'setInterval', 'setTimeout'].map(
      (name) => [name, g[name]],
    ),
  );
  g.document = {
    getElementById: (id: string) => {
      const found = elements.get(id) ?? new FakeElement('div');
      elements.set(id, found);
      return found;
    },
    querySelectorAll: () => [],
    createElement: (tag: string) => new FakeElement(tag),
    body: new FakeElement('body'),
  };
  g.location = { hash: '', pathname: '/' };
  g.history = { replaceState() {} };
  g.window = { setTimeout: () => 0 };
  g.setInterval = () => 0;
  g.setTimeout = () => 0;
  let polled = Promise.withResolvers<void>();
  g.fetch = async (path: string) => {
    const body = path === '/api/session' ? { csrf: 'csrf-token' } : status;
    if (path === '/api/status') queueMicrotask(() => polled.resolve());
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    await import(new URL(`../page/console.js?case=${Math.random()}`, import.meta.url).href);
    await polled.promise;
    // 让 render 在应答之后的微任务里跑完。
    await new Promise((resolve) => setImmediate(resolve));
    return (id: string) => elements.get(id) ?? new FakeElement('missing');
  } finally {
    polled = Promise.withResolvers<void>();
    Object.assign(g, saved);
  }
}

const status = {
  mode: 'safe-stop',
  maintenance: false,
  moderationEnabled: false,
  presenceValid: false,
  presenceRemainingMs: 0,
  presentation: null,
  review: null,
  held: [],
  vote: null,
  danmaku: null,
  llm: null,
  memory: null,
  persona: null,
  preflight: null,
  plugins: [],
  alerts: [],
};

test('操作台只读显示结果未知的意图：编号、类型、目标、能否对账与意图键，并提示用命令行结案', async () => {
  const byId = await renderPage({
    ...status,
    unresolved: [
      {
        id: 7,
        key: 'memory.write:memory#b0.3:1',
        type: 'memory.write',
        target: 'iris:bellis:drill',
        capabilities: ['memory.write'],
        timeSensitive: false,
        since: '2026-10-22T00:00:00.000Z',
      },
    ],
  });
  assert.equal(
    byId('unresolved-summary').textContent,
    '1 个，目标已隔离：核对后用 pnpm operator resolve <编号> <succeeded|failed> 结案',
  );
  const rows = byId('unresolved').children.map((row) => row.textContent);
  assert.equal(rows.length, 1);
  assert.match(
    rows[0] ?? '',
    /^#7 memory\.write → iris:bellis:drill（可对账，memory\.write:memory#b0\.3:1，.+ 起）$/,
  );
});

test('操作台：没有结果未知的意图时显示“没有”，读不出状态存储时如实说明', async () => {
  const none = await renderPage({ ...status, unresolved: [] });
  assert.equal(none('unresolved-summary').textContent, '没有');
  assert.deepEqual(none('unresolved').children, []);
  const broken = await renderPage({ ...status, unresolved: null });
  assert.equal(broken('unresolved-summary').textContent, '读不出状态存储');
});
