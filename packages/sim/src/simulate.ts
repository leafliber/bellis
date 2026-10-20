import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoteService, type Votes } from '@bellis/audience';
import { ReplayLlmService } from '@bellis/director';
import { checkHistory, type History } from './invariants.ts';
import { type Scenario, scenarioEntries } from './scenario.ts';
import { type TraceEntry, World } from './world.ts';

export interface SimulationOptions {
  /** 每步推进的模拟时间。 */
  stepMs?: number;
  /** 场景结束后不再有新输入、继续推进以排空的时间。 */
  drainMs?: number;
  /** 排空时间到了仍有进行中的意图时，最多再推进这么久等它结束；超过即判为卡住。 */
  settleMs?: number;
}

export interface SimulationResult {
  violations: string[];
  history: History;
  restarts: number;
}

/**
 * 运行一个场景（R-07）：同一个种子总得到同一条追踪。
 * 每一步检查执行许可至多一个持有者、许可令牌不回退；结束后检查排空与追踪上的不变量。
 * 场景里的“重启”模拟进程崩溃：放弃当前世界，在同一个状态存储上重新启动，
 * 由操作员结案结果未知的意图后切回 M0。
 */
export async function simulate(
  scenario: Scenario,
  options: SimulationOptions = {},
): Promise<SimulationResult> {
  const stepMs = options.stepMs ?? 10;
  const drainMs = options.drainMs ?? 15_000;
  const dir = mkdtempSync(join(tmpdir(), 'bellis-sim-'));
  const storePath = join(dir, 'state.db');
  const trace: TraceEntry[] = [];
  const violations: string[] = [];
  const tokens = new Map<string, number>();
  let restarts = 0;
  let outputsUsed = 0;

  const boot = async (fromMs: number, startAt: number): Promise<World> => {
    const world = new World({
      entries: scenarioEntries(scenario, fromMs, outputsUsed),
      moderationEnabled: scenario.moderation.enabled,
      seed: scenario.seed + restarts,
      storePath,
      startAt,
      bootId: `b${restarts}`,
    });
    world.record('world.start', { restarts });
    await world.kernel.settled();
    for (const intent of world.store.intentsIn('unknown')) {
      world.store.resolve(intent.id, { ok: false, error: '仿真：操作员确认未播出' }, 'operator');
    }
    const mode = world.safety.requestMode('M0');
    if (!mode.ok) violations.push(`启动后无法进入 M0：${mode.reason}`);
    return world;
  };
  const collect = (world: World) => {
    for (const entry of world.trace) trace.push({ ...entry, seq: trace.length });
  };

  let world = await boot(0, 0);
  const operations = [...scenario.operator].sort((a, b) => a.atMs - b.atMs);
  let next = 0;
  try {
    for (let elapsed = 0; elapsed < scenario.durationMs + drainMs; elapsed += stepMs) {
      while (
        elapsed < scenario.durationMs &&
        (operations[next]?.atMs ?? Number.POSITIVE_INFINITY) <= elapsed
      ) {
        const operation = operations[next++];
        if (operation?.action === 'estop') {
          void world.safety.emergencyStop('仿真急停');
        } else if (operation?.action === 'upgrade') {
          world.safety.requestMode('M0');
        } else if (operation?.action === 'restart') {
          outputsUsed += world.service(ReplayLlmService).requests.length;
          collect(world);
          const { now } = world.crash();
          restarts += 1;
          world = await boot(elapsed, now);
        }
      }
      world.clock.advance(stepMs);
      await world.flush();

      const holders = world.safety.leases.holders().map((lease) => lease.resource);
      if (new Set(holders).size !== holders.length)
        violations.push(`同一资源出现多个许可持有者：${holders.join(',')}`);
      for (const resource of ['stage.audio']) {
        const token = world.store.token(resource);
        if (token < (tokens.get(resource) ?? 0))
          violations.push(`${resource} 的令牌回退到 ${token}`);
        tokens.set(resource, token);
      }
      if (violations.length > 0) break;
    }

    // 冷场闲聊可能在排空期间开始新的发言，投票可能还在倒计时：等进行中的意图与投票结束，超过上限才判为卡住。
    const inflight = () => [
      ...world.store.intentsIn('pending'),
      ...world.store.intentsIn('executing'),
    ];
    const voting = () => {
      const found = world.kernel.services.resolve(VoteService.name, VoteService.major);
      return 'missing' in found ? undefined : (found.impl as Votes).current();
    };
    for (
      let waited = 0;
      (inflight().length > 0 || voting() !== undefined) && waited < (options.settleMs ?? 60_000);
      waited += stepMs
    ) {
      world.clock.advance(stepMs);
      await world.flush();
    }
    const stuck = inflight();
    if (stuck.length > 0)
      violations.push(`排空后仍有未完成的意图：${stuck.map((i) => i.key).join(', ')}`);
    const open = voting();
    if (open) violations.push(`排空后仍有进行中的投票：${open.voteId}`);
    const busy = world.kernel
      .snapshot()
      .filter((e) => ['loading', 'quiescing', 'unloading'].includes(e.state));
    if (busy.length > 0)
      violations.push(
        `排空后仍有插件处在过渡状态：${busy.map((e) => `${e.id}:${e.state}`).join(', ')}`,
      );

    collect(world);
    const history: History = {
      trace,
      events: world.store.events(),
      moderationEnabled: scenario.moderation.enabled,
    };
    violations.push(...checkHistory(history));
    return { violations, history, restarts };
  } finally {
    await world.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
