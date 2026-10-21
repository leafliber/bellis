import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoteService, type Votes } from '@bellis/audience';
import { ReplayLlmService } from '@bellis/director';
import { SimIrisBackend, tombstoneFact } from '@bellis/memory';
import type { ObsChange } from '@bellis/safety';
import { type TelemetryMemory, TelemetryMemoryService } from '@bellis/telemetry';
import { checkHistory, type History } from './invariants.ts';
import { type Scenario, scenarioEntries } from './scenario.ts';
import { simSafety, type TraceEntry, World } from './world.ts';

export interface SimulationOptions {
  /** 每步推进的模拟时间。 */
  stepMs?: number;
  /** 场景结束后不再有新输入、继续推进以排空的时间。 */
  drainMs?: number;
  /** 排空时间到了仍有进行中的意图时，最多再推进这么久等它结束；超过即判为卡住。 */
  settleMs?: number;
  /** 启用写内存的遥测并检查它的不变量，缺省启用；关掉用于核对遥测不改变仿真的行为。 */
  telemetry?: boolean;
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
 * 由操作员结案结果未知的意图后切回场景的模式（M0，或真实输出模式的场景切到 M2）。
 * 每个操作员动作先写进追踪（`operator.action`；OBS 外部变化带上它会不会改变 OBS 的状态）。
 */
export async function simulate(
  scenario: Scenario,
  options: SimulationOptions = {},
): Promise<SimulationResult> {
  const stepMs = options.stepMs ?? 10;
  const drainMs = options.drainMs ?? 15_000;
  const withTelemetry = options.telemetry ?? true;
  const dir = mkdtempSync(join(tmpdir(), 'bellis-sim-'));
  const storePath = join(dir, 'state.db');
  const trace: TraceEntry[] = [];
  /** 各次启动的遥测输出（JSONL 行）；崩溃时还没写出的部分随进程丢失。 */
  const telemetry: string[] = [];
  const violations: string[] = [];
  const tokens = new Map<string, number>();
  let restarts = 0;
  let outputsUsed = 0;
  /** 模拟 Iris 是进程外的服务：宿主崩溃重启，它的数据还在。 */
  const iris = new SimIrisBackend();

  const target = scenario.mode ?? 'M0';
  /** 操作员切到场景的模式：M2 先确认在场。 */
  const enter = (world: World) => {
    if (target === 'M2') world.safety.confirmPresence();
    return world.safety.requestMode(target);
  };

  const boot = async (fromMs: number, startAt: number): Promise<World> => {
    const world = new World({
      entries: scenarioEntries(scenario, fromMs, outputsUsed, { telemetry: withTelemetry }),
      moderationEnabled: scenario.moderation.enabled,
      seed: scenario.seed + restarts,
      storePath,
      startAt,
      bootId: `b${restarts}`,
      iris,
      // 真实输出模式的场景：安全核按非仿真配置，只允许 M1–M3（设备仍是模拟的）。
      ...(target === 'M2' ? { safety: { simulation: false } } : {}),
    });
    world.record('world.start', { restarts });
    await world.kernel.settled();
    for (const intent of world.store.intentsIn('unknown')) {
      world.store.resolve(intent.id, { ok: false, error: '仿真：操作员确认未播出' }, 'operator');
    }
    const mode = enter(world);
    if (!mode.ok) violations.push(`启动后无法进入 ${target}：${mode.reason}`);
    return world;
  };
  const collect = (world: World) => {
    for (const entry of world.trace) trace.push({ ...entry, seq: trace.length });
    if (!withTelemetry) return;
    const found = world.kernel.services.resolve(
      TelemetryMemoryService.name,
      TelemetryMemoryService.major,
    );
    if ('missing' in found) violations.push(`遥测不在场：${found.missing}`);
    else telemetry.push(...(found.impl as TelemetryMemory).lines);
  };

  let world = await boot(0, 0);
  const operations = [...scenario.operator].sort((a, b) => a.atMs - b.atMs);
  let next = 0;
  const forgets = [...(scenario.memory?.forget ?? [])].sort((a, b) => a.atMs - b.atMs);
  let nextForget = 0;
  try {
    for (let elapsed = 0; elapsed < scenario.durationMs + drainMs; elapsed += stepMs) {
      while (
        elapsed < scenario.durationMs &&
        (operations[next]?.atMs ?? Number.POSITIVE_INFINITY) <= elapsed
      ) {
        const operation = operations[next++];
        if (!operation) break;
        const { safeScene, stageSource } = simSafety.emergency;
        const change: ObsChange | undefined =
          operation.action === 'obs-scene'
            ? { kind: 'scene', sceneName: safeScene }
            : operation.action === 'obs-mute'
              ? { kind: 'mute', inputName: stageSource, muted: true }
              : undefined;
        world.record('operator.action', {
          action: operation.action,
          ...(change ? { changed: world.obs.changes(change) } : {}),
        });
        if (change) {
          // 在 OBS 里按热键或手动操作，不经 Bellis。
          world.obs.external(change);
        } else if (operation.action === 'estop') {
          void world.safety.emergencyStop('仿真急停');
        } else if (operation.action === 'upgrade') {
          // 像操作员一样先把 OBS 切回直播场景、取消静音，再升级。
          world.obs.external({ kind: 'scene', sceneName: 'Live' });
          world.obs.external({ kind: 'mute', inputName: stageSource, muted: false });
          enter(world);
        } else if (operation.action === 'restart') {
          outputsUsed += world.service(ReplayLlmService).requests.length;
          collect(world);
          const { now } = world.crash();
          restarts += 1;
          world = await boot(elapsed, now);
        }
      }
      // 操作员登记墓碑（与 pnpm operator forget 记同一条事实）。
      while (
        elapsed < scenario.durationMs &&
        (forgets[nextForget]?.atMs ?? Number.POSITIVE_INFINITY) <= elapsed
      ) {
        const forget = forgets[nextForget++];
        const fact = forget ? tombstoneFact(`v${forget.viewer}`) : undefined;
        if (fact) world.safety.record(fact.type, fact.data);
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
      ...(withTelemetry ? { telemetry } : {}),
    };
    violations.push(...checkHistory(history));
    return { violations, history, restarts };
  } finally {
    await world.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
