import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (file: string) => readFileSync(new URL(`../page/${file}`, import.meta.url), 'utf8');

test('页面只用 textContent 渲染宿主的文本，不解析 HTML', () => {
  const script = read('console.js');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
    assert.ok(!script.includes(sink), sink);
  }
  assert.match(script, /textContent/);
});

test('页面不从外部加载任何东西，也没有内联脚本与样式', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /(https?:)?\/\/[a-z0-9]/i);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]?.[1]?.trim(), '');
  assert.match(html, /<script type="module" src="\/console\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/console\.css" crossorigin="anonymous" \/>/);
  // 脚本只连本源的接口。
  const script = read('console.js');
  assert.doesNotMatch(script, /(https?:|wss?:)\/\//);
});

test('登录令牌读出后立即从地址栏抹掉，CSRF 令牌只放在内存里', () => {
  const script = read('console.js');
  assert.match(script, /history\.replaceState\(null, '', location\.pathname\)/);
  for (const storage of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.ok(!script.includes(storage), storage);
  }
});
