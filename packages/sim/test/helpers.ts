import type { ResolvedEntry } from '@bellis/kernel';
import type { SimIrisBackend } from '@bellis/memory';
import type { SafetyConfig } from '@bellis/safety';
import { World } from '../src/index.ts';

export function entry(
  id: string,
  plugin: string,
  extra: Partial<ResolvedEntry> = {},
): ResolvedEntry {
  return { id, plugin, config: {}, disabled: false, explicitSwitch: false, grant: [], ...extra };
}

export interface ChainOptions {
  messages?: Array<{ atMs: number; id: string; viewer: string; nickname: string; text: string }>;
  outputs?: string[];
  announcements?: Array<{ id: string; atMs: number; text: string }>;
  preempt?: 'sentence' | 'immediate';
  moderation?: {
    enabled: boolean;
    blocked?: string[];
    failOn?: string[];
    hangOn?: string[];
    delayMs?: number;
    onError?: 'skip' | 'pass';
  };
  tts?: Record<string, unknown>;
  safety?: Partial<SafetyConfig>;
  withoutModerationModel?: boolean;
  /** 加上投票插件（给出它的配置）。 */
  vote?: Record<string, unknown>;
  /** 加上写内存的遥测（`telemetry-memory`）。 */
  telemetry?: boolean;
  /** 决策插件的配置。 */
  director?: Record<string, unknown>;
  /** 加上模拟 Iris 与记忆插件：模拟 Iris 的配置、记忆插件的配置与跨重启保留的数据。 */
  memory?: {
    iris?: Record<string, unknown>;
    config?: Record<string, unknown>;
    backend?: SimIrisBackend;
  };
  /** 状态存储文件（重启用）与本次启动的标识。 */
  storePath?: string;
  bootId?: string;
  startAt?: number;
}

/** 全模拟发声链路：录制弹幕 → 分诊 → 回放模型输出 → 分句 → 审核 → 仲裁 → 模拟 TTS → 模拟 Stage。 */
export function chain(options: ChainOptions = {}): ResolvedEntry[] {
  const moderationConfig = options.moderation ?? { enabled: true };
  return [
    entry('stage-page', 'stage-page-sim'),
    entry('stage', 'stage-service'),
    entry('tts', 'tts-sim', { config: options.tts ?? {} }),
    entry('speech', 'speech-arbiter', { grant: ['speech.output'] }),
    ...(options.withoutModerationModel
      ? []
      : [
          entry('moderation-model', 'moderation-model-sim', {
            config: {
              blocked: moderationConfig.blocked ?? [],
              failOn: moderationConfig.failOn ?? [],
              hangOn: moderationConfig.hangOn ?? [],
              delayMs: moderationConfig.delayMs ?? 0,
            },
          }),
        ]),
    entry('moderation', 'moderation', {
      disabled: !moderationConfig.enabled,
      explicitSwitch: true,
      config: { onError: moderationConfig.onError ?? 'skip', timeoutMs: 500 },
    }),
    entry('danmaku', 'danmaku-replay', { config: { messages: options.messages ?? [] } }),
    entry('triage', 'audience-triage'),
    ...(options.vote
      ? [entry('vote', 'audience-vote', { grant: ['vote.start'], config: options.vote })]
      : []),
    entry('llm', 'llm-replay', { config: { outputs: options.outputs ?? [] } }),
    entry('director', 'director', { config: options.director ?? {} }),
    entry('schedule', 'speech-schedule', {
      config: {
        announcements: options.announcements ?? [],
        preempt: options.preempt ?? 'sentence',
      },
    }),
    ...(options.memory
      ? [
          entry('iris', 'iris-sim', { config: options.memory.iris ?? {} }),
          entry('memory', 'memory', {
            grant: ['memory.write'],
            config: { entryId: 'sim:room', ...options.memory.config },
          }),
        ]
      : []),
    ...(options.telemetry ? [entry('telemetry', 'telemetry-memory')] : []),
  ];
}

export async function startChain(options: ChainOptions = {}) {
  const world = new World({
    entries: chain(options),
    moderationEnabled: options.moderation?.enabled ?? true,
    ...(options.safety ? { safety: options.safety } : {}),
    ...(options.storePath ? { storePath: options.storePath } : {}),
    ...(options.bootId ? { bootId: options.bootId } : {}),
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
    ...(options.memory?.backend ? { iris: options.memory.backend } : {}),
  });
  await world.kernel.settled();
  const mode = world.safety.requestMode('M0');
  if (!mode.ok) throw new Error(mode.reason);
  return world;
}

export interface Played {
  id: string;
  source: string;
  heard: string;
  end: string;
  reason?: string;
  interruptedMidSentence: boolean;
  skipped: Array<{ index: number; reason: string }>;
}

export function played(world: World): Played[] {
  return world.events('utterance.played').map((event) => event.data as Played);
}

export const speak = (text: string, replyTo?: string) =>
  JSON.stringify({ action: 'speak', text, ...(replyTo ? { replyTo } : {}) });
