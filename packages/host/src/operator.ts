/**
 * 操作员动作（R-20）：命令行（本机通道上的 `operator.*` RPC）与操作台（`/api/*`）调用同一套函数，
 * 参数用同一份 TypeBox Schema 校验，行为与记录完全一致。操作台与命令行一样由宿主装配，不经插件加载器，
 * 插件出问题时照样可用。
 */
import type { VoteStatus } from '@bellis/audience';
import type { RpcPeer } from '@bellis/channel';
import { type ConsoleRoute, InvalidParams } from '@bellis/console';
import type { EntrySnapshot } from '@bellis/kernel';
import { tombstoneFact } from '@bellis/memory';
import {
  type OperatorConsoleLoginResult,
  OperatorEmergencyParams,
  OperatorForgetParams,
  OperatorMethod,
  OperatorModeParams,
  OperatorPreflightParams,
  OperatorReleaseParams,
  OperatorResolveParams,
  OperatorVetoParams,
} from '@bellis/protocol';
import type { EmergencyReport, Mode, SafetyCore } from '@bellis/safety';
import type { HeldSentence, ReviewMode, ReviewSettings } from '@bellis/speech';
import type { Presentation } from '@bellis/stage';
import type { Intent, StoredEvent } from '@bellis/store';
import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { DanmakuReport, LlmReport, MemoryStatusReport } from './readiness.ts';

export type Target = 'M1' | 'M2' | 'M3';

/**
 * 结果未知的意图（状态存储里停在 unknown 的）：它隔离了自己的目标，要所有者对账或操作员结案
 * （`pnpm operator resolve`）。只有编号、键、类型、目标与能力，没有载荷。
 */
export interface UnresolvedIntent {
  id: number;
  key: string;
  type: string;
  target: string;
  capabilities: string[];
  /** 有时效的只能由操作员结案；没有时效的通常由所有者对账，所有者不在场时也由操作员结案。 */
  timeSensitive: boolean;
  /** 标为结果未知的时刻。 */
  since: string;
}

/** M1 中等待放行的一句（来自 `speech.held`）。 */
export interface HeldEntry extends HeldSentence {
  /** 等待的方式：固定延迟（delay）或待操作员放行（approve）。 */
  mode: ReviewMode;
  delayMs?: number;
  timeoutMs?: number;
  heldAt: string;
  waitedMs: number;
}

export interface PluginStatus {
  id: string;
  plugin: string;
  state: string;
  reason: string | null;
}

/** 最近一次开播预检（只跑预检，或切到 M1–M3 前跑的）。 */
export interface PreflightRecord {
  target: Target;
  failures: string[];
  at: string;
  by: 'preflight' | 'mode';
}

export interface OperatorStatus {
  mode: Mode;
  maintenance: boolean;
  moderationEnabled: boolean | null;
  presenceValid: boolean;
  presenceRemainingMs: number;
  presentation: Presentation | null;
  /** M1 的放行环节的设置；不在场时为 null。 */
  review: ReviewSettings | null;
  held: HeldEntry[];
  /** 进行中的投票（题目、选项、票数、剩余时间）；没有投票或投票插件不在场时为 null。 */
  vote: VoteStatus | null;
  /** 弹幕接入：就绪与否、状态说明、当前缺口；profile 中没有启用弹幕接入时为 null。 */
  danmaku: DanmakuReport | null;
  /**
   * 决策模型（llm@1）：就绪与否、状态说明、最近一次失败的类别与时间、连续失败数；profile 中没有启用决策插件、
   * 也没有模型客户端时为 null。
   */
  llm: LlmReport | null;
  /**
   * 记忆（memory@1 与 Iris）：就绪与否、状态说明、待发队列、累计写入与丢弃、墓碑数；profile 中没有启用记忆、
   * 也没有记忆插件时为 null。
   */
  memory: MemoryStatusReport | null;
  /** 结果未知的意图（目标被隔离）；读不出状态存储时为 null。 */
  unresolved: UnresolvedIntent[] | null;
  preflight: PreflightRecord | null;
  plugins: PluginStatus[];
}

/** 近期告警：宿主订阅状态存储，环形保存最近的重要事实。 */
export interface Alert {
  seq: number;
  at: string;
  type: string;
  text: string;
}

export type ModeResult = { ok: true } | { ok: false; reason: string; failures?: string[] };

export interface OperatorDeps {
  core: SafetyCore;
  /** 订阅状态存储提交后的新事实。 */
  subscribe(listener: (event: StoredEvent) => void): () => void;
  plugins(): readonly EntrySnapshot[];
  presentation(): Presentation | null;
  review(): ReviewSettings | null;
  /** 进行中的投票；不给时状态里总是 null。 */
  vote?(): VoteStatus | null;
  /** 弹幕接入的状态；不给时状态里总是 null。 */
  danmaku?(): DanmakuReport | null;
  /** 决策模型的状态；不给时状态里总是 null。 */
  llm?(): LlmReport | null;
  /** 记忆的状态；不给时状态里总是 null。 */
  memory?(): MemoryStatusReport | null;
  /** 开播预检；withSafety 时先列出安全核的前置条件（见 preflight.ts）。 */
  preflight(target: Target, withSafety: boolean): Promise<string[]>;
  /** 操作台的一次性登录令牌；操作台没有启动时为 undefined。 */
  consoleLogin(): OperatorConsoleLoginResult | undefined;
  /** 墙钟（毫秒），缺省 Date.now。 */
  now?(): number;
  /** 近期告警保留的条数，缺省 50。 */
  alertLimit?: number;
}

export interface OperatorApi {
  status(): OperatorStatus;
  alerts(): Alert[];
  /** 切换模式。进入 M1–M3 前先由安全核核对前置条件，再过开播预检；升级只能经这里显式发起。 */
  mode(params: OperatorModeParams): Promise<ModeResult>;
  /** 确认在场（M2 的前提）。 */
  presence(): { ok: true };
  emergencyStop(params: OperatorEmergencyParams): Promise<EmergencyReport>;
  veto(params: OperatorVetoParams): { ok: true; vetoed: string[] };
  release(params: OperatorReleaseParams): { ok: true; released: string[] };
  preflight(params: OperatorPreflightParams): Promise<{ target: Target; failures: string[] }>;
  consoleLogin(): OperatorConsoleLoginResult | { ok: false; reason: string };
  /** 登记观众删除请求的本地墓碑（事实 memory.tombstoned）。 */
  forget(params: OperatorForgetParams): { ok: true } | { ok: false; reason: string };
  /**
   * 操作员结案：为结果未知的意图补记结局（事实 `intent.reconciled`，`by: "operator"`），目标随之不再隔离。
   * 不是结果未知的意图、状态存储不可用时拒绝。
   */
  resolve(
    params: OperatorResolveParams,
  ): { ok: true; intent: UnresolvedIntent & { state: string } } | { ok: false; reason: string };
  /** 取消对状态存储的订阅。 */
  dispose(): void;
}

/** 写进近期告警的事实与它们的说明。 */
const ALERTS: Record<string, (data: Record<string, unknown>) => string | undefined> = {
  'supervision.changed': (d) => `模式 ${d.from} → ${d.to}：${d.reason}`,
  'supervision.refused': (d) =>
    `拒绝切到 ${d.to}：${d.reason}${Array.isArray(d.failures) && d.failures.length > 0 ? `（${d.failures.join('；')}）` : ''}`,
  'safety.emergency-requested': (d) => `急停：${d.reason}`,
  'safety.emergency-completed': (d) =>
    `急停完成：${d.reason}（OBS 应急动作${d.ok === true ? '成功' : `失败：${d.error ?? ''}`}）`,
  'safety.obs-external': (d) =>
    d.change === 'scene'
      ? `OBS 外部切到安全场景「${d.scene}」${d.resync === true ? '（重连后核对发现）' : ''}`
      : `OBS 外部静音了 Stage 源「${d.input}」${d.resync === true ? '（重连后核对发现）' : ''}`,
  'watchdog.acted': (d) =>
    `看门狗已执行应急动作（${d.reason}，OBS ${d.ok === true ? '已确认' : '未确认'}）`,
  'speech.vetoed': (d) => `已否决：${d.subtitle}`,
  'speech.withdrawn': (d) => (d.timedOut === true ? `等待放行超时，已撤回：${d.key}` : undefined),
  'moderation.switched': (d) => (d.enabled === true ? '审核插件已启用' : '审核插件已关闭'),
  'tts.switched': (d) => `TTS 换引擎：${d.from ?? '无'} → ${d.to ?? '无'}（${d.reason}）`,
  'tts.degraded': (d) => `TTS 降级：${d.engine}（${d.reason}）`,
  'danmaku.gap-started': (d) => `弹幕缺口开始：${d.platform}（${d.reason}）`,
  'danmaku.gap-ended': (d) =>
    `弹幕缺口结束：${d.platform}，${d.recovered === true ? '已恢复' : '未恢复'}，持续 ${d.durationMs}ms`,
  'vote.aborted': (d) => `投票中止：${d.voteId}（${d.reason}）`,
  // 只说登记了，不写观众的平台身份。
  'memory.tombstoned': () => '已登记一名观众的本地墓碑（记忆）',
  'director.alarmed': (d) =>
    d.cause === 'drift'
      ? `决策输出连续 ${d.count} 次重复或漂移（${d.detail}），已请求降级`
      : `决策模型连续失败 ${d.count} 次（最近一次：${d.detail}），已请求降级`,
  'intent.reconciled': (d) =>
    d.by === 'operator'
      ? `操作员结案：意图 ${d.id}（${'result' in d ? 'succeeded' : 'failed'}）`
      : undefined,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 宿主装配的操作员动作：订阅状态存储，跟踪等待放行的句子与近期告警。 */
export function createOperator(deps: OperatorDeps): OperatorApi {
  const { core } = deps;
  const now = deps.now ?? Date.now;
  const limit = deps.alertLimit ?? 50;
  const held = new Map<string, { entry: Omit<HeldEntry, 'heldAt' | 'waitedMs'>; at: number }>();
  const alerts: Alert[] = [];
  let lastPreflight: PreflightRecord | null = null;

  const unsubscribe = deps.subscribe((event) => {
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'speech.held' && typeof data.key === 'string') {
      held.set(data.key, {
        entry: data as unknown as Omit<HeldEntry, 'heldAt' | 'waitedMs'>,
        at: now(),
      });
    } else if (
      ['speech.released', 'speech.vetoed', 'speech.withdrawn'].includes(event.type) &&
      typeof data.key === 'string'
    ) {
      held.delete(data.key);
    }
    const text = ALERTS[event.type]?.(data);
    if (text !== undefined) {
      alerts.push({
        seq: event.seq,
        at: new Date(event.recordedAt).toISOString(),
        type: event.type,
        text,
      });
      if (alerts.length > limit) alerts.splice(0, alerts.length - limit);
    }
  });

  const runPreflight = async (target: Target, withSafety: boolean, by: PreflightRecord['by']) => {
    const failures = await deps.preflight(target, withSafety);
    lastPreflight = { target, failures, at: new Date(now()).toISOString(), by };
    return failures;
  };

  const describeIntent = (intent: Intent): UnresolvedIntent => ({
    id: intent.id,
    key: intent.key,
    type: intent.type,
    target: intent.target,
    capabilities: [...intent.capabilities],
    timeSensitive: intent.timeSensitive,
    since: new Date(intent.updatedAt).toISOString(),
  });
  const unresolved = (): UnresolvedIntent[] | null => {
    try {
      return core.store.intentsIn('unknown').map(describeIntent);
    } catch {
      return null;
    }
  };

  /** 送出前在等待中的句键，送出后不再等待的就是被处理了的。 */
  const settled = (key: string | undefined, send: () => void): string[] => {
    const before = key === undefined ? [...held.keys()] : held.has(key) ? [key] : [];
    send();
    return before.filter((k) => !held.has(k));
  };

  return {
    status() {
      const at = now();
      return {
        mode: core.mode,
        maintenance: core.maintenance,
        moderationEnabled: core.moderationEnabled ?? null,
        presenceValid: core.presenceValid(),
        presenceRemainingMs: core.presenceRemainingMs(),
        presentation: deps.presentation(),
        review: deps.review(),
        held: [...held.values()].map(({ entry, at: since }) => ({
          ...entry,
          heldAt: new Date(since).toISOString(),
          waitedMs: Math.max(0, at - since),
        })),
        vote: deps.vote?.() ?? null,
        danmaku: deps.danmaku?.() ?? null,
        llm: deps.llm?.() ?? null,
        memory: deps.memory?.() ?? null,
        unresolved: unresolved(),
        preflight: lastPreflight,
        plugins: deps.plugins().map((e) => ({
          id: e.id,
          plugin: e.plugin,
          state: e.state,
          reason: e.reason ?? null,
        })),
      };
    },
    alerts: () => [...alerts],
    async mode({ target }) {
      // 进入真实输出模式前先过开播预检，任一项未通过都不切换（降级与安全停止不受影响）。
      // 安全核的前置条件先核对（未满足时由 requestMode 记录并拒绝），满足后再过开播预检。
      if ((target === 'M1' || target === 'M2' || target === 'M3') && !core.modeBlocker(target)) {
        const failures = await runPreflight(target, false, 'mode');
        if (failures.length > 0) {
          core.record('supervision.refused', {
            from: core.mode,
            to: target,
            reason: '开播预检未通过',
            failures,
          });
          return { ok: false, reason: '开播预检未通过', failures };
        }
      }
      return core.requestMode(target);
    },
    presence() {
      core.confirmPresence();
      return { ok: true };
    },
    emergencyStop({ reason }) {
      return core.emergencyStop(reason ?? '操作员急停');
    },
    veto({ key }) {
      return { ok: true, vetoed: settled(key, () => core.veto(key)) };
    },
    release({ key }) {
      return { ok: true, released: settled(key, () => core.release(key)) };
    },
    async preflight({ target = 'M1' }) {
      return { target, failures: await runPreflight(target, true, 'preflight') };
    },
    consoleLogin() {
      return deps.consoleLogin() ?? { ok: false, reason: '操作台没有启动' };
    },
    forget({ account }) {
      // 墓碑记在本地状态存储里，记忆插件在不在场都生效（投影重建）；平台身份不写日志。
      const fact = tombstoneFact(account);
      if (!fact) return { ok: false, reason: '参数不合法' };
      try {
        core.store.append(fact.type, fact.data, { source: 'operator' });
      } catch {
        return { ok: false, reason: '状态存储不可用，墓碑没有记下' };
      }
      return { ok: true };
    },
    resolve({ id, outcome }) {
      let intent: Intent | undefined;
      try {
        intent = core.store.intent(id);
        if (intent?.state !== 'unknown')
          return { ok: false, reason: `意图 ${id} 不是结果未知的意图` };
        const resolved = core.store.resolve(
          id,
          outcome === 'succeeded'
            ? { ok: true, result: null }
            : { ok: false, error: '操作员结案：按没有发生处理' },
          'operator',
        );
        return { ok: true, intent: { ...describeIntent(resolved), state: resolved.state } };
      } catch {
        return { ok: false, reason: '状态存储不可用，没有结案' };
      }
    },
    dispose: unsubscribe,
  };
}

type Method = (typeof OperatorMethod)[keyof typeof OperatorMethod];

function checked<T>(schema: TSchema): (params: unknown) => T {
  const validator = Compile(schema);
  return (params) => {
    if (!validator.Check(params)) throw new InvalidParams();
    return params as T;
  };
}

const modeParams = checked<OperatorModeParams>(OperatorModeParams);
const vetoParams = checked<OperatorVetoParams>(OperatorVetoParams);
const releaseParams = checked<OperatorReleaseParams>(OperatorReleaseParams);
const preflightParams = checked<OperatorPreflightParams>(OperatorPreflightParams);
const forgetParams = checked<OperatorForgetParams>(OperatorForgetParams);
const resolveParams = checked<OperatorResolveParams>(OperatorResolveParams);
const isEmergencyParams = Compile(OperatorEmergencyParams);

/**
 * 命令行与操作台共用的入口：按方法名校验参数并调用操作员动作。参数不合法时抛 InvalidParams；
 * 急停例外，参数不合法也照样急停，只是用缺省原因（急停不能因为原因写错而被拒绝）。
 */
export function operatorActions(api: OperatorApi): Record<Method, (params: unknown) => unknown> {
  return {
    [OperatorMethod.Status]: () => api.status(),
    [OperatorMethod.Mode]: (params) => api.mode(modeParams(params)),
    [OperatorMethod.Presence]: () => api.presence(),
    [OperatorMethod.EmergencyStop]: (params) =>
      api.emergencyStop(isEmergencyParams.Check(params) ? params : {}),
    [OperatorMethod.Veto]: (params) => api.veto(vetoParams(params)),
    [OperatorMethod.Release]: (params) => api.release(releaseParams(params)),
    [OperatorMethod.Preflight]: (params) => api.preflight(preflightParams(params)),
    [OperatorMethod.ConsoleLogin]: () => api.consoleLogin(),
    [OperatorMethod.Forget]: (params) => api.forget(forgetParams(params)),
    [OperatorMethod.Resolve]: (params) => api.resolve(resolveParams(params)),
  };
}

/** 本机通道上的操作员命令（`pnpm operator`）。参数不合法时回 `{ ok: false, reason: '参数不合法' }`。 */
export function serveOperator(rpc: RpcPeer, api: OperatorApi): void {
  for (const [method, action] of Object.entries(operatorActions(api))) {
    rpc.handle(method, async (params) => {
      try {
        return await action(params);
      } catch (error) {
        if (error instanceof InvalidParams) return { ok: false, reason: error.message };
        throw error;
      }
    });
  }
}

/** 操作台的 `/api/*` 接口：与命令行调同一套动作；登录、会话与注销由操作台服务自己处理。 */
export function consoleRoutes(api: OperatorApi): Record<string, ConsoleRoute> {
  const actions = operatorActions(api);
  const post = (method: Method): ConsoleRoute => ({ method: 'POST', run: actions[method] });
  return {
    '/api/status': { method: 'GET', run: () => ({ ...api.status(), alerts: api.alerts() }) },
    '/api/mode': post(OperatorMethod.Mode),
    '/api/presence': post(OperatorMethod.Presence),
    '/api/emergency-stop': post(OperatorMethod.EmergencyStop),
    '/api/veto': post(OperatorMethod.Veto),
    '/api/release': post(OperatorMethod.Release),
    '/api/preflight': post(OperatorMethod.Preflight),
  };
}
