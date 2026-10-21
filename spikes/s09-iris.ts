/**
 * 探针 S-09：iris-core 在本机 Docker 中稳定运行，宿主经 127.0.0.1 访问，召回在预算内（见 docs/plan/spikes.md）。
 *
 *   node spikes/s09-iris.ts --egress-reviewed [--base-url http://127.0.0.1:8080] [--entry bellis:s09]
 *        [--rounds 20] [--judge-budget-s 2] [--learn-wait-s 0] [--restart-check] [--out 结果文件]
 *     --egress-reviewed  必须显式给出：确认维护者已核对 Iris 的外发配置（Iris 会把探针写入的合成样本发给它配置的
 *                        模型学习，合规“Iris 外发”）。
 *     --entry            测试专用的入口 ID，缺省 bellis:s09，不用正式直播间的入口；宿主令牌的范围须包含它。
 *     --rounds           召回判断关闭与打开各测多少次召回准备（prepare）。
 *     --judge-budget-s   打开召回判断时的预算（秒，只能缩短缺省的 10 秒）。
 *     --learn-wait-s     写入后请求立即学习（POST /entries/{id}/learn），至多等这么久再测召回；0 表示不等。
 *     --restart-check    写入之后提示操作员手动运行 `docker restart iris`（探针自己不运行 docker），按回车后
 *                        等 Iris 重新就绪，再用同样的去重键写一次：返回同样的消息 ID 即数据仍在。
 *     --fake             不连 Iris：在本机起按契约实现的伪 Iris，用来检查探针本身（令牌用随机值）。
 *
 * 宿主接口契约测试（只用宿主接口 v1，见 iris-core docs/host-api.md）：
 * - 状态：GET /status 以宿主令牌访问，服务为 ready；错误的令牌得 401；非回环的 Host 得 400；
 * - 写入的幂等：同一批去重键重写一次（正文改了）返回同样的消息 ID；
 * - 召回准备：关闭召回判断（judge=false），不取人物要点、人物摘要、近期原始消息与目标，返回 recall_id；
 * - 定向查询：POST /memories/search 带入口；
 * - 使用反馈：空集被接受；有记忆时回报一条，重复回报不再强化；不属于这次召回的记忆得 400。
 * 召回判断关闭与打开时的延迟分布：各 rounds 次，记 p50/p95/p99（最近秩法，失败样本另计，不剔除）。
 *
 * 凭据按宿主装配插件的方式读取（`pluginSecrets`，只放行 `secret:iris`），来自 SecretStore 服务名 bellis，
 * 只在本进程内用于请求头；不复制、不打印、不写进结果。结果写 reports/S-09-<日期>.json（不入库）。
 * 写入的都是合成样本（不是观众数据），去重键带本次运行的编号。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { arch, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { IRIS_DEFAULT_URL, IRIS_SECRET, IrisClient } from '@bellis/iris';
import { type PluginSecrets, secretPermission, systemClock } from '@bellis/kernel';
import { entryIdBlocker, IrisError, type IrisMessage, irisFailureText } from '@bellis/memory';
import { KeyringSecretStore, MemorySecretStore, type SecretStore } from '@bellis/secret-store';
import { pluginSecrets } from '../packages/host/src/secrets.ts';
import { FakeIris } from '../packages/iris/test/fake-iris.ts';

const clock = systemClock();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** 最近秩法的分位数：升序样本里第 ⌈q·n⌉ 个。 */
function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1] ?? null;
}

function summary(samples: readonly number[], failures: readonly string[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);
  return {
    n: samples.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? null),
    failures: failures.length,
    failureKinds: [...new Set(failures)],
  };
}

const describe = (error: unknown) =>
  error instanceof IrisError
    ? irisFailureText(error)
    : error instanceof Error
      ? error.message
      : String(error);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** 用指定的 Host 头发一个 GET /api/v1/status（fetch 不能改 Host），返回 HTTP 状态。 */
function statusWithHost(baseUrl: string, host: string, token: string): Promise<number> {
  const url = new URL('/api/v1/status', baseUrl);
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: { host, authorization: `Bearer ${token}` },
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode ?? 0));
      },
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', fail);
    req.end();
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'egress-reviewed': { type: 'boolean', default: false },
      fake: { type: 'boolean', default: false },
      'base-url': { type: 'string', default: IRIS_DEFAULT_URL },
      entry: { type: 'string', default: 'bellis:s09' },
      rounds: { type: 'string', default: '20' },
      'judge-budget-s': { type: 'string', default: '2' },
      'learn-wait-s': { type: 'string', default: '0' },
      'restart-check': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  if (!values['egress-reviewed'] && !values.fake) {
    throw new Error(
      '需要 --egress-reviewed：确认维护者已核对 Iris 的外发配置（Iris 会把探针写入的合成样本发给它的模型学习）',
    );
  }
  const entry = values.entry;
  const blocked = entryIdBlocker(entry);
  if (blocked) throw new Error(`--entry 不合法：${blocked}`);
  const rounds = Number(values.rounds);
  const judgeBudget = Number(values['judge-budget-s']);
  const learnWaitS = Number(values['learn-wait-s']);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds 须为正整数');
  if (!(judgeBudget > 0 && judgeBudget <= 10)) throw new Error('--judge-budget-s 须在 (0, 10] 内');
  if (!(learnWaitS >= 0)) throw new Error('--learn-wait-s 须为非负数');

  // 凭据：与宿主给插件的凭据服务相同，只放行 secret:iris。--fake 时用随机值与内存存储。
  let store: SecretStore = new KeyringSecretStore('bellis');
  let baseUrl = values['base-url'];
  let fake: FakeIris | undefined;
  if (values.fake) {
    store = new MemorySecretStore();
    const token = randomBytes(16).toString('hex');
    await store.set(IRIS_SECRET, token);
    fake = await FakeIris.start(token);
    baseUrl = fake.url;
  }
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('--base-url 须为本机回环的 http 地址（Iris 端口只映射到 127.0.0.1，见 D-23）');
  }
  const secrets: PluginSecrets = pluginSecrets(
    store,
    new Set([secretPermission(IRIS_SECRET)]),
    new Set(['session', 'obs', 'obs-sim']),
  );
  let token: string | undefined;
  try {
    token = (await secrets.read(IRIS_SECRET))?.trim();
  } catch (error) {
    throw new Error(`读不到 SecretStore（bellis）中的 ${IRIS_SECRET}：${describe(error)}`);
  }
  if (!token) {
    throw new Error(
      `SecretStore（bellis）中没有 ${IRIS_SECRET}，请维护者先在 Iris 管理端创建宿主令牌，再用 pnpm secret set ${IRIS_SECRET} 录入`,
    );
  }
  const client = new IrisClient({
    baseUrl,
    token,
    clock,
    requestTimeoutMs: 30_000,
    maxResponseBytes: 8 * 1024 * 1024,
  });
  const signal = () => new AbortController().signal;
  const runId = `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}-${randomBytes(3).toString('hex')}`;
  const started = new Date().toISOString();
  const out = resolve(values.out ?? join('reports', `S-09-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? '通过' : '未通过'}：${name}（${detail}）`);
  };

  // 0. 连得上：以宿主令牌访问 GET /status。连不上就停，不往下测。
  let statusFields: string[] = [];
  try {
    const status = await client.status(signal());
    statusFields = Object.keys(status.raw).sort();
    check('以宿主令牌访问 GET /status', status.service === 'ready', `service=${status.service}`);
  } catch (error) {
    throw new Error(
      `连不上 Iris（${baseUrl}）：${describe(error)}。确认容器已启动、端口映射到 127.0.0.1、令牌有效且范围包含入口 ${entry}`,
    );
  }
  try {
    await new IrisClient({
      baseUrl,
      token: `wrong-${randomBytes(8).toString('hex')}`,
      clock,
      requestTimeoutMs: 10_000,
      maxResponseBytes: 1024 * 1024,
    }).status(signal());
    check('错误的令牌被拒（401）', false, '错误的令牌也能访问');
  } catch (error) {
    check(
      '错误的令牌被拒（401）',
      error instanceof IrisError && error.kind === 'auth',
      describe(error),
    );
  }
  try {
    const status = await statusWithHost(baseUrl, 'evil.example', token);
    check('非回环的 Host 被拒（400）', status === 400, `HTTP ${status}`);
  } catch (error) {
    check('非回环的 Host 被拒（400）', false, describe(error));
  }

  // 1. 写入的幂等：同一批去重键重写一次（正文改了），返回同样的消息 ID。
  const at = new Date().toISOString();
  const message = (n: number, content: string): IrisMessage => ({
    platform: 'bellis-s09',
    sender: n % 2 === 0 ? '主播' : '观众s09',
    ...(n % 2 === 0 ? {} : { accountId: `s09-viewer-${runId}` }),
    content,
    occurredAt: at,
    dedupeKey: `s09:${runId}:${n}`,
    kind: n % 2 === 0 ? 'self_output' : 'message',
    entryName: 'S-09 探针',
    entryKind: 'live',
    pace: 'realtime',
  });
  const topic = `观星${runId.slice(-6)}`;
  const batch = [
    message(1, `今晚想看${topic}，带了三脚架`),
    message(2, `${topic}要找没有光污染的地方`),
    message(3, `下次${topic}记得带热水`),
  ];
  let ids: number[] = [];
  try {
    ids = (await client.writeMessages(entry, batch, signal())).messageIds;
    const again = await client.writeMessages(
      entry,
      batch.map((m) => ({ ...m, content: `${m.content}（重试改了正文）` })),
      signal(),
    );
    check(
      '写入的幂等：同一去重键重写返回同样的消息 ID',
      JSON.stringify(again.messageIds) === JSON.stringify(ids),
      `第一次 ${ids.join(',')}，重写 ${again.messageIds.join(',')}`,
    );
  } catch (error) {
    check('写入的幂等：同一去重键重写返回同样的消息 ID', false, describe(error));
  }

  // 可选：请求立即学习，等学习批次结束（至多 learn-wait-s 秒）。
  if (learnWaitS > 0) {
    try {
      await client.request(
        'POST',
        `/entries/${encodeURIComponent(entry)}/learn`,
        undefined,
        signal(),
      );
      const deadline = Date.now() + learnWaitS * 1000;
      for (;;) {
        const status = await client.status(signal());
        const entries = Array.isArray(status.raw.entries) ? status.raw.entries : [];
        const mine = entries.find(
          (e) =>
            typeof e === 'object' && e !== null && (e as { entry_id?: unknown }).entry_id === entry,
        ) as { pending_count?: unknown } | undefined;
        if (!mine || mine.pending_count === 0 || Date.now() > deadline) break;
        await sleep(2_000);
      }
    } catch (error) {
      console.log(`请求立即学习失败：${describe(error)}`);
    }
  }

  // 2. 召回准备与 3. 定向查询、4. 使用反馈。
  try {
    const recall = await client.prepare(
      entry,
      { text: topic, judge: false, memoryLimit: 8, tokenBudget: 1500 },
      signal(),
    );
    check(
      '召回准备（judge=false）返回 recall_id 与记忆',
      recall.recallId !== '',
      `记忆 ${recall.memories.length} 条，召回判断 ${recall.judgment ?? '?'}`,
    );
    const empty = await client.feedback(recall.recallId, [], signal());
    check('使用反馈：空集被接受', empty.accepted.length === 0, JSON.stringify(empty));
    const first = recall.memories[0];
    if (first) {
      const once = await client.feedback(recall.recallId, [first.id], signal());
      const twice = await client.feedback(recall.recallId, [first.id], signal());
      check(
        '使用反馈：回报一条记忆，重复回报不再强化',
        once.accepted.includes(first.id) && twice.strengthened.length === 0,
        `第一次 ${JSON.stringify(once)}，第二次 ${JSON.stringify(twice)}`,
      );
    } else {
      check('使用反馈：回报一条记忆，重复回报不再强化', true, '没有召回到记忆（还没学习），跳过');
    }
    try {
      await client.feedback(recall.recallId, [2 ** 31 - 1], signal());
      check('使用反馈：不属于这次召回的记忆被拒（400）', false, '被接受了');
    } catch (error) {
      check(
        '使用反馈：不属于这次召回的记忆被拒（400）',
        error instanceof IrisError && (error.kind === 'invalid' || error.kind === 'not_found'),
        describe(error),
      );
    }
  } catch (error) {
    check('召回准备（judge=false）返回 recall_id 与记忆', false, describe(error));
  }
  try {
    const found = await client.search({ text: topic, entryId: entry, limit: 8 }, signal());
    check(
      '定向查询（POST /memories/search，带入口）',
      found.recallId !== '',
      `记忆 ${found.memories.length} 条`,
    );
  } catch (error) {
    check('定向查询（POST /memories/search，带入口）', false, describe(error));
  }

  // 5. 召回判断关闭与打开时的延迟分布。
  const latency = async (judge: boolean) => {
    const samples: number[] = [];
    const failures: string[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const t0 = performance.now();
      try {
        await client.prepare(
          entry,
          {
            text: topic,
            judge,
            ...(judge ? { judgeBudgetSeconds: judgeBudget } : {}),
            memoryLimit: 8,
            tokenBudget: 1500,
          },
          signal(),
        );
        samples.push(performance.now() - t0);
      } catch (error) {
        failures.push(error instanceof IrisError ? error.kind : 'error');
      }
    }
    return summary(samples, failures);
  };
  const judgeOff = await latency(false);
  console.log(`召回判断关闭：${JSON.stringify(judgeOff)}`);
  const judgeOn = await latency(true);
  console.log(`召回判断打开（预算 ${judgeBudget} 秒）：${JSON.stringify(judgeOn)}`);

  // 6. 容器重启后数据仍在（操作员手动重启，探针不运行 docker）。
  let restart: Record<string, unknown> | null = null;
  if (values['restart-check']) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(
      '请在另一个终端运行 `docker restart iris`（容器名按实际），重启命令返回后按回车继续……',
    );
    rl.close();
    const waitStarted = Date.now();
    let ready = false;
    while (Date.now() - waitStarted < 180_000) {
      try {
        if ((await client.status(signal())).service === 'ready') {
          ready = true;
          break;
        }
      } catch {
        // 还在启动。
      }
      await sleep(1_000);
    }
    let persisted = false;
    let detail = '重启后 3 分钟内没有就绪';
    if (ready) {
      try {
        const again = await client.writeMessages(entry, batch, signal());
        persisted = JSON.stringify(again.messageIds) === JSON.stringify(ids) && ids.length > 0;
        detail = `重启前 ${ids.join(',')}，重启后同样的去重键 ${again.messageIds.join(',')}`;
      } catch (error) {
        detail = describe(error);
      }
    }
    restart = { readyAfterMs: ready ? Date.now() - waitStarted : null, persisted, detail };
    check('容器重启后数据仍在（同样的去重键返回同样的消息 ID）', persisted, detail);
  }

  const report = {
    probe: 'S-09',
    started,
    finished: new Date().toISOString(),
    system: { platform: platform(), release: release(), arch: arch(), node: process.version },
    command: `node spikes/s09-iris.ts ${process.argv.slice(2).join(' ')}`,
    baseUrl,
    entry,
    runId,
    fake: values.fake,
    statusFields,
    checks,
    latency: {
      judgeOff,
      judgeOn: { ...judgeOn, judgeBudgetSeconds: judgeBudget },
      rounds,
      note: '召回准备从发出到收到完整应答（含 JSON 解析），本机回环；失败样本另计，不剔除',
    },
    restart,
    limitations: [
      '只测宿主接口 v1 中 Bellis 用到的部分；事件流（SSE）、目标与状态接口不在范围内',
      '召回内容取决于 Iris 是否已学习这些合成样本（学习批次的耗时见 iris-core 自述），未学习时只能核对接口形状',
      '容器重启由操作员手动执行，探针只核对重启后同样的去重键返回同样的消息 ID',
    ],
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`结果：${out}`);
  await fake?.close();
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
