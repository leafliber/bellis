// @ts-check
/**
 * 本机操作台页面（R-20）。宿主按原样提供，不用前端框架、不从外部加载任何东西。
 *
 * - 登录：一次性令牌在 URL 片段里（`#令牌`），读出后立即用 history.replaceState 抹掉，用它 POST /api/login
 *   换会话（HttpOnly cookie）与会话绑定的 CSRF 令牌；没有令牌时（例如刷新了页面）用 GET /api/session 取回
 *   CSRF 令牌。CSRF 令牌只放在内存里，写请求放在 X-Bellis-CSRF 请求头。
 * - 每秒轮询 GET /api/status。连不上宿主或会话失效时醒目提示，并把状态清成未知：不把过期的数据当作当前状态。
 * - 一切来自宿主的文本（句子可能受弹幕影响）只用 textContent 渲染。
 * - 急停一键执行；升级到 M1–M3 要再点一次确认；在场确认必须操作员主动点，页面在线不算在场。
 */

/** @typedef {'M0' | 'M1' | 'M2' | 'M3' | 'safe-stop'} Mode */
/**
 * @typedef {object} Held
 * @property {string} key
 * @property {string} source
 * @property {string} subtitle
 * @property {'delay' | 'approve'} mode
 * @property {number} [delayMs]
 * @property {number} [timeoutMs]
 * @property {number} waitedMs
 */
/** @typedef {{ id: string, plugin: string, state: string, reason: string | null }} PluginRow */
/** @typedef {{ seq: number, at: string, type: string, text: string }} Alert */
/** @typedef {{ target: string, failures: string[], at: string, by: 'preflight' | 'mode' }} Preflight */
/**
 * @typedef {object} Vote
 * @property {string} voteId
 * @property {string} question
 * @property {string[]} options
 * @property {number[]} counts
 * @property {number} valid
 * @property {'announcing' | 'open'} phase
 * @property {number} durationMs
 * @property {number | null} remainingMs
 * @property {string | null} decisionPoint
 * @property {boolean} gap
 */
/**
 * @typedef {object} Status
 * @property {Mode} mode
 * @property {boolean} maintenance
 * @property {boolean | null} moderationEnabled
 * @property {boolean} presenceValid
 * @property {number} presenceRemainingMs
 * @property {{ delayMs: number, samples: number, source: string } | null} presentation
 * @property {{ mode: 'delay' | 'approve', delayMs: number, approveTimeoutMs: number } | null} review
 * @property {Held[]} held
 * @property {Vote | null} vote
 * @property {Preflight | null} preflight
 * @property {PluginRow[]} plugins
 * @property {Alert[]} alerts
 */
/** @typedef {{ status: number, data: unknown }} Reply */

const POLL_MS = 1000;
/** 这么久没有成功的轮询，就不再把显示的状态当作当前状态。 */
const STALE_MS = 2500;
const REQUEST_TIMEOUT_MS = 3000;
/** 升级的二次确认在这段时间内有效。 */
const CONFIRM_MS = 5000;
/** @type {Record<Mode, number>} */
const RANK = { 'safe-stop': 0, M0: 0.5, M1: 1, M2: 2, M3: 3 };

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function byId(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`页面缺少 #${id}`);
  return found;
}

const moderationBanner = byId('moderation');
const connectionBanner = byId('connection');
const messageBox = byId('message');
const modeText = byId('mode');
const presenceText = byId('presence');
const maintenanceText = byId('maintenance');
const presentationText = byId('presentation');
const updatedText = byId('updated');
const reviewModeText = byId('review-mode');
const heldList = byId('held');
const heldEmpty = byId('held-empty');
const voteSummary = byId('vote-summary');
const voteOptions = byId('vote-options');
const preflightSummary = byId('preflight-summary');
const preflightFailures = byId('preflight-failures');
const pluginRows = byId('plugins');
const alertList = byId('alerts');
const preflightTarget = /** @type {HTMLSelectElement} */ (byId('preflight-target'));
/** @type {HTMLButtonElement[]} */
const modeButtons = [...document.querySelectorAll('button[data-mode]')].map(
  (node) => /** @type {HTMLButtonElement} */ (node),
);

// 令牌只在片段里，读出后立即抹掉：不留在地址栏、历史记录与之后的 Referer 里。
const loginToken = location.hash.length > 1 ? location.hash.slice(1) : null;
history.replaceState(null, '', location.pathname);

/** 会话绑定的 CSRF 令牌，只放在内存里。 @type {string | null} */
let csrf = null;
/** @type {Status | null} */
let current = null;
let lastOk = 0;
let loggedOut = false;
/** 等待二次确认的目标模式。 @type {{ mode: Mode, timer: number } | null} */
let armed = null;
/** 已显示的告警（最后一条的编号），只在变化时重建列表。 */
let alertsShown = -1;
let pluginsShown = '';
let preflightShown = '';
/** @type {Map<string, { row: HTMLLIElement, waited: HTMLElement }>} */
const heldRows = new Map();

/**
 * @param {string} tag
 * @param {string} [text]
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

/**
 * @param {HTMLElement} node
 * @param {string} text
 */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/**
 * @param {string} text
 * @param {boolean} [error]
 */
function say(text, error = false) {
  messageBox.hidden = false;
  messageBox.className = error ? 'message error' : 'message';
  messageBox.textContent = `${new Date().toLocaleTimeString()} ${text}`;
}

/** @param {number} ms */
function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * 调宿主的接口。写请求带 JSON 与 CSRF 令牌；超时、断开时抛错。
 * @param {'GET' | 'POST'} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<Reply>}
 */
async function call(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    /** @type {Record<string, string>} */
    const headers = {};
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      if (csrf !== null) headers['x-bellis-csrf'] = csrf;
    }
    const response = await fetch(path, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : null,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  return typeof value === 'object' && value !== null
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** 状态未知：连不上宿主或会话失效时，不显示过期的数据。 */
function clearStatus() {
  current = null;
  document.body.classList.add('stale');
  setText(modeText, '未知');
  setText(presenceText, '未知');
  setText(maintenanceText, '未知');
  setText(presentationText, '未知');
  moderationBanner.className = 'banner';
  setText(moderationBanner, '审核状态未知（没有宿主的当前状态）');
  for (const button of modeButtons) button.classList.remove('current');
  // 等待放行的句子可以操作，过期了就不再列出；其余部分变灰保留，便于排查。
  renderHeld([]);
  heldEmpty.hidden = true;
}

/** @param {string} why */
function offline(why) {
  connectionBanner.hidden = false;
  setText(
    connectionBanner,
    `${why}。下面不是当前状态${lastOk > 0 ? `（最后一次成功：${new Date(lastOk).toLocaleTimeString()}）` : ''}`,
  );
  clearStatus();
}

/** @param {Status} status */
function render(status) {
  current = status;
  lastOk = Date.now();
  connectionBanner.hidden = true;
  document.body.classList.remove('stale');

  // 审核状态常显在顶部。
  if (status.moderationEnabled === false) {
    moderationBanner.className = 'banner moderation-off';
    setText(moderationBanner, '审核已关闭');
  } else if (status.moderationEnabled === null) {
    moderationBanner.className = 'banner moderation-unset';
    setText(moderationBanner, '审核状态未设置');
  } else {
    moderationBanner.className = 'banner moderation-on';
    setText(moderationBanner, '审核已启用');
  }

  setText(modeText, status.mode === 'safe-stop' ? '安全停止' : status.mode);
  setText(
    presenceText,
    status.presenceValid ? `有效，剩余 ${duration(status.presenceRemainingMs)}` : '无效',
  );
  setText(maintenanceText, status.maintenance ? '是' : '否');
  setText(
    presentationText,
    status.presentation
      ? `${status.presentation.delayMs}ms（${status.presentation.source}）`
      : '没有 Stage 服务',
  );
  setText(updatedText, new Date(lastOk).toLocaleTimeString());
  for (const button of modeButtons) {
    button.classList.toggle('current', button.dataset.mode === status.mode);
  }

  setText(
    reviewModeText,
    status.review === null
      ? '（没有放行环节，M1 下一句也不播）'
      : status.review.mode === 'approve'
        ? `（逐句放行，${Math.round(status.review.approveTimeoutMs / 1000)} 秒内不放行就撤回）`
        : `（固定延迟 ${status.review.delayMs}ms 后放行，期间可否决或提前放行）`,
  );
  renderHeld(status.held);
  renderVote(status.vote);
  renderPreflight(status.preflight);
  renderPlugins(status.plugins);
  renderAlerts(status.alerts);
}

/** @param {Held[]} held */
function renderHeld(held) {
  const keys = new Set(held.map((item) => item.key));
  for (const [key, entry] of heldRows) {
    if (!keys.has(key)) {
      entry.row.remove();
      heldRows.delete(key);
    }
  }
  for (const item of held) {
    let entry = heldRows.get(item.key);
    if (!entry) {
      const row = /** @type {HTMLLIElement} */ (make('li'));
      row.append(make('span', item.subtitle, 'subtitle'));
      row.append(make('span', `来源 ${item.source} · ${item.key}`, 'meta'));
      const waited = make('span', '', 'meta');
      row.append(waited);
      const release = make('button', '放行');
      release.addEventListener('click', () => act('/api/release', { key: item.key }, '放行'));
      const veto = make('button', '否决');
      veto.addEventListener('click', () => act('/api/veto', { key: item.key }, '否决'));
      const buttons = make('span', undefined, 'group');
      buttons.append(release, veto);
      row.append(buttons);
      heldList.append(row);
      entry = { row, waited };
      heldRows.set(item.key, entry);
    }
    const limit =
      item.mode === 'approve'
        ? `待放行，${item.timeoutMs === undefined ? '' : `${duration(item.timeoutMs - item.waitedMs)} 后撤回`}`
        : `延迟中，${item.delayMs === undefined ? '' : `${duration(item.delayMs - item.waitedMs)} 后放行`}`;
    setText(entry.waited, `已等 ${duration(item.waitedMs)} · ${limit}`);
  }
  heldEmpty.hidden = held.length > 0;
}

/**
 * 进行中的投票：题目、阶段与剩余时间、各项票数。题目与选项来自模型，只用 textContent 渲染。
 * @param {Vote | null} vote
 */
function renderVote(vote) {
  if (vote === null) {
    setText(voteSummary, '没有进行中的投票');
    voteOptions.replaceChildren();
    return;
  }
  const phase =
    vote.phase === 'announcing' || vote.remainingMs === null
      ? `开票说明播报中，播完后计时 ${duration(vote.durationMs)}`
      : `剩余 ${duration(vote.remainingMs)}`;
  setText(
    voteSummary,
    `${vote.question}（${phase}，有效票 ${vote.valid}${vote.gap ? '，弹幕接收中断中' : ''}）`,
  );
  const rows = vote.options.map((option, i) => make('li', `${option}：${vote.counts[i] ?? 0} 票`));
  voteOptions.replaceChildren(...rows);
}

/** @param {Preflight | null} preflight */
function renderPreflight(preflight) {
  const key = JSON.stringify(preflight);
  if (key === preflightShown) return;
  preflightShown = key;
  preflightFailures.replaceChildren();
  if (preflight === null) {
    setText(preflightSummary, '本次宿主运行中还没有跑过开播预检');
    return;
  }
  const by = preflight.by === 'mode' ? '切换模式前' : '只跑预检';
  const when = new Date(preflight.at).toLocaleTimeString();
  setText(
    preflightSummary,
    preflight.failures.length === 0
      ? `${when} ${by}（${preflight.target}）：全部通过`
      : `${when} ${by}（${preflight.target}）：${preflight.failures.length} 项未通过`,
  );
  for (const failure of preflight.failures) preflightFailures.append(make('li', failure));
}

/** @param {PluginRow[]} plugins */
function renderPlugins(plugins) {
  const key = JSON.stringify(plugins);
  if (key === pluginsShown) return;
  pluginsShown = key;
  pluginRows.replaceChildren(
    ...plugins.map((plugin) => {
      const row = make('tr');
      row.append(
        make('td', plugin.id),
        make('td', plugin.plugin),
        make('td', plugin.state, `state-${plugin.state}`),
        make('td', plugin.reason ?? ''),
      );
      return row;
    }),
  );
}

/** @param {Alert[]} alerts */
function renderAlerts(alerts) {
  const last = alerts.at(-1)?.seq ?? 0;
  if (last === alertsShown) return;
  alertsShown = last;
  alertList.replaceChildren(
    ...[...alerts].reverse().map((alert) => {
      const item = make('li');
      const time = make('time', new Date(alert.at).toLocaleTimeString());
      time.setAttribute('datetime', alert.at);
      item.append(time, make('span', alert.text));
      return item;
    }),
  );
}

async function poll() {
  if (loggedOut) return;
  try {
    const reply = await call('GET', '/api/status');
    // 等待应答期间注销了：不再显示状态。
    if (loggedOut) return;
    if (reply.status === 200) render(/** @type {Status} */ (reply.data));
    else if (reply.status === 401) offline('会话已失效，重新运行 pnpm operator console 登录');
    else offline(`宿主拒绝了请求（${reply.status}）`);
  } catch {
    if (!loggedOut) offline('连不上宿主');
  }
}

async function loop() {
  await poll();
  if (!loggedOut) setTimeout(loop, POLL_MS);
}

/**
 * 发一个写请求，并把结果写进提示栏。
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {string} label
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function act(path, body, label) {
  if (csrf === null) {
    say(`${label}没有送出：尚未登录`, true);
    return null;
  }
  try {
    const reply = await call('POST', path, body);
    const data = record(reply.data);
    if (reply.status !== 200) {
      say(`${label}被拒绝（${reply.status}${data.reason ? `：${data.reason}` : ''}）`, true);
      return null;
    }
    void poll();
    return data;
  } catch {
    say(`${label}没有送达宿主`, true);
    return null;
  }
}

/** @param {Mode} target */
function needsConfirm(target) {
  if (target !== 'M1' && target !== 'M2' && target !== 'M3') return false;
  return current === null || RANK[target] > RANK[current.mode];
}

function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed = null;
  for (const button of modeButtons) {
    button.classList.remove('armed');
    setText(button, button.dataset.mode === 'safe-stop' ? '安全停止' : (button.dataset.mode ?? ''));
  }
}

/**
 * @param {HTMLButtonElement} button
 * @param {Mode} target
 */
async function switchMode(button, target) {
  if (needsConfirm(target) && armed?.mode !== target) {
    disarm();
    armed = { mode: target, timer: window.setTimeout(disarm, CONFIRM_MS) };
    button.classList.add('armed');
    setText(button, `确认进入 ${target}？`);
    return;
  }
  disarm();
  const data = await act('/api/mode', { target }, `切换到 ${target}`);
  if (!data) return;
  if (data.ok === true) say(`已切换到 ${target}`);
  else {
    const failures = Array.isArray(data.failures) ? `：${data.failures.join('；')}` : '';
    say(`没有切换到 ${target}：${data.reason}${failures}`, true);
  }
}

byId('estop').addEventListener('click', async () => {
  // 急停一键执行，不要二次确认。
  const data = await act('/api/emergency-stop', {}, '急停');
  if (!data) {
    say('急停请求没有送达宿主！立即用 OBS 热键，或运行 pnpm operator estop', true);
    return;
  }
  const obs = record(data.obs);
  say(
    obs.ok === true
      ? '已急停：许可已吊销，OBS 已静音并切到安全场景'
      : `已急停，但 OBS 应急动作失败：${obs.error ?? ''}。到 OBS 里手动静音并切到安全场景`,
    obs.ok !== true,
  );
});

byId('presence-confirm').addEventListener('click', async () => {
  const data = await act('/api/presence', {}, '确认在场');
  if (data?.ok === true) say('已确认在场');
});

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    const target = /** @type {Mode} */ (button.dataset.mode);
    void switchMode(button, target);
  });
}

byId('preflight-run').addEventListener('click', async () => {
  const data = await act('/api/preflight', { target: preflightTarget.value }, '开播预检');
  if (!data) return;
  const failures = Array.isArray(data.failures) ? data.failures : [];
  say(failures.length === 0 ? '开播预检全部通过' : `开播预检有 ${failures.length} 项未通过`);
});

byId('veto-all').addEventListener('click', async () => {
  const data = await act('/api/veto', {}, '全部否决');
  if (data) say(`已否决 ${Array.isArray(data.vetoed) ? data.vetoed.length : 0} 句`);
});

byId('logout').addEventListener('click', async () => {
  await act('/api/logout', {}, '注销');
  loggedOut = true;
  csrf = null;
  offline('已注销。重新运行 pnpm operator console 登录');
});

// 定时把太久没更新的状态清成未知（轮询卡住时也不显示过期的数据）。
setInterval(() => {
  if (current !== null && Date.now() - lastOk > STALE_MS) offline('连不上宿主');
}, 500);

async function login() {
  try {
    const reply = loginToken
      ? await call('POST', '/api/login', { token: loginToken })
      : await call('GET', '/api/session');
    const data = record(reply.data);
    if (reply.status === 200 && typeof data.csrf === 'string') {
      csrf = data.csrf;
      return true;
    }
    offline(
      loginToken
        ? '登录失败：令牌无效、已用过或已过期。重新运行 pnpm operator console'
        : '未登录。运行 pnpm operator console 登录',
    );
  } catch {
    offline('连不上宿主');
  }
  return false;
}

if (await login()) void loop();

// 模块脚本（顶层 await）；不导出任何东西。
export {};
