import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { RpcPeer } from '@bellis/channel';
import {
  type Game,
  gameChoiceOptionsDigest,
  LOCAL_DIALOGUE_GOAL_RPC_MS,
} from '@bellis/game-bridge';
import type { ResolvedEntry } from '@bellis/kernel';
import { type EmergencyPolicy, EventSubscription, ObsClient, type ObsResult } from '@bellis/obs';
import {
  type GameLocalDialogue,
  type GameLocalRecovery,
  OperatorLocalDialogueStart,
  OperatorLocalDialogueStartParams,
  OperatorLocalNamedChoiceStart,
  OperatorLocalNamedChoiceStartParams,
  OperatorLocalRecoveryStart,
  OperatorLocalRecoveryStartParams,
  Role,
  SessionId,
} from '@bellis/protocol';
import type { ObsCredentials, SafetyCore } from '@bellis/safety';
import { Compile } from 'typebox/compile';

const isStart = Compile(OperatorLocalDialogueStartParams);
const isRecoveryStart = Compile(OperatorLocalRecoveryStartParams);
const isNamedChoiceStart = Compile(OperatorLocalNamedChoiceStartParams);
const isSession = Compile(SessionId);
const OBS_SAMPLE_MS = 500;
const LOCAL_GOAL_OBJECTIVES = {
  dialogue: '只推进当前游戏窗口的普通对白或旁白，出现选择、调查、存读档、过场或其它页面时停下。',
  recover: '在已签名的坏结局打开游戏读取页，并读取唯一可验证的最新自动存档。核验实际落点后停下。',
  load: '在上一授权已验效打开的同一自动读取页上，读取唯一可验证的最新自动存档。核验实际落点后停下。',
} as const;
const OUTPUTS = [
  'GetStreamStatus',
  'GetRecordStatus',
  'GetReplayBufferStatus',
  'GetVirtualCamStatus',
];
const OUTPUT_EVENTS = new Set([
  'StreamStateChanged',
  'RecordStateChanged',
  'ReplayBufferStateChanged',
  'VirtualcamStateChanged',
  'ExitStarted',
  'CurrentSceneCollectionChanging',
  'CurrentProfileChanging',
]);

function outputInactive(output: ObsResult, index: number): boolean {
  if (output.ok)
    return output.data?.outputActive === false && output.data?.outputReconnecting !== true;
  // The two optional OBS outputs report an unavailable resource when disabled.
  return (
    output.code === 604 &&
    ((index === 2 && output.comment === 'Replay buffer is not available.') ||
      (index === 3 && output.comment === 'VirtualCam is not available.'))
  );
}

/** 由受信任的部署装配提供，profile 只可请求该适配包已获批的操作。 */
export interface LocalGameAdmission {
  readonly adapterId: string;
  readonly dialogue?: true;
  readonly recovery?: true;
  readonly namedChoice?: true;
}

/** 仅对获准的适配包与操作解析隔离 profile。 */
export function localGameEntry(
  simulation: boolean,
  entries: readonly ResolvedEntry[],
  admission?: LocalGameAdmission,
) {
  const enabled = entries.filter((entry) => !entry.disabled);
  const game = enabled.find(
    ({ plugin, config }) =>
      plugin === 'game-bridge' &&
      typeof config === 'object' &&
      config !== null &&
      (('localDialogue' in config && config.localDialogue === true) ||
        ('localRecovery' in config && config.localRecovery === true) ||
        ('localNamedChoice' in config && config.localNamedChoice === true)),
  );
  if (!game) return undefined;
  const settings = game.config as Record<string, unknown>;
  const dialogue = settings.localDialogue === true;
  const recovery = settings.localRecovery === true;
  const namedChoice = settings.localNamedChoice === true;
  if (
    !admission ||
    settings.adapterId !== admission.adapterId ||
    (dialogue && admission.dialogue !== true) ||
    (recovery && admission.recovery !== true) ||
    (namedChoice && admission.namedChoice !== true)
  )
    throw new Error('受信任的部署策略未批准本机游戏适配包或操作');
  const moderation = entries.find(({ id }) => id === 'moderation');
  if (
    simulation ||
    moderation?.plugin !== 'moderation' ||
    !moderation.explicitSwitch ||
    !moderation.disabled ||
    settings.controlTargetId !== undefined ||
    game.grant.length !== 2 ||
    !game.grant.includes('game.input') ||
    !game.grant.includes('game.goal') ||
    enabled.some(
      (entry) => entry !== game && (entry.plugin !== 'telemetry' || entry.grant.length > 0),
    )
  )
    throw new Error('本机游戏 profile 只启用游戏桥与无外部权限的本地遥测');
  return {
    id: game.id,
    adapterId: admission.adapterId,
    dialogue,
    recovery,
    namedChoice,
  };
}

export interface LocalGameOperatorOptions {
  entry: NonNullable<ReturnType<typeof localGameEntry>>;
  core: SafetyCore;
  sessionId: unknown;
  holder(): string | undefined;
  game(): Game | undefined;
}

export function serveLocalGame(rpc: RpcPeer, options: LocalGameOperatorOptions): void {
  if (rpc.connection.role !== Role.Operator) return;
  for (const [method, enabled, rpcMethod] of [
    ['dialogue', options.entry.dialogue, OperatorLocalDialogueStart],
    ['recovery', options.entry.recovery, OperatorLocalRecoveryStart],
    ['named-choice', options.entry.namedChoice, OperatorLocalNamedChoiceStart],
  ] as const) {
    if (!enabled) continue;
    rpc.handle(rpcMethod, (params, { signal }) =>
      startLocalGame(
        method,
        params,
        signal,
        options.core,
        options.sessionId,
        options.holder(),
        options.game(),
      ),
    );
  }
}

/** 实时核验本机 OBS 的应急场景、静音和输出状态。 */
export function monitorLocalGameObs(
  credentials: ObsCredentials,
  policy: EmergencyPolicy,
  unchanged: () => boolean,
  invalidated: (reason: string) => void,
  log: (event: string, data: Record<string, unknown>) => void,
) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(credentials.url).hostname))
    throw new Error('本机对白要求本机 OBS');
  let client: ObsClient | undefined;
  let checking = false;
  let closed = false;
  let expiresAt = 0;
  let revision = 0;
  let sceneChanging = false;
  const ready = () => !closed && client?.connected === true && performance.now() < expiresAt;
  function invalidate(reason: string) {
    revision += 1;
    expiresAt = 0;
    if (!closed) invalidated(reason);
  }
  async function read(): Promise<void> {
    if (closed || checking || sceneChanging) return;
    checking = true;
    try {
      if (!client?.connected) {
        const connected = await ObsClient.connect(credentials.url, credentials.password, {
          timeoutMs: OBS_SAMPLE_MS,
          eventSubscriptions:
            EventSubscription.General |
            EventSubscription.Config |
            EventSubscription.Scenes |
            EventSubscription.Inputs |
            EventSubscription.Outputs,
        });
        if (closed) {
          connected.close();
          return;
        }
        client = connected;
        connected.onClose(() => {
          sceneChanging = false;
          invalidate('本机对白的 OBS 连接断开');
        });
        connected.onEvent((event, data) => {
          if (event === 'CurrentSceneCollectionChanging') sceneChanging = true;
          if (event === 'CurrentSceneCollectionChanged') sceneChanging = false;
          if (
            OUTPUT_EVENTS.has(event) ||
            (event === 'CurrentProgramSceneChanged' && data.sceneName !== policy.safeScene) ||
            (event === 'InputMuteStateChanged' &&
              data.inputName === policy.stageSource &&
              data.inputMuted !== true)
          )
            invalidate('本机对白期间 OBS 状态发生变化');
        });
      }
      const started = performance.now();
      const observedRevision = revision;
      const rows = await client.batch(
        [
          { requestType: 'GetCurrentProgramScene' },
          { requestType: 'GetInputMute', requestData: { inputName: policy.stageSource } },
          ...OUTPUTS.map((requestType) => ({ requestType })),
          { requestType: 'GetOutputList' },
        ],
        { timeoutMs: OBS_SAMPLE_MS },
      );
      const [scene, stage, ...outputs] = rows;
      const listed = outputs.pop();
      const list = listed?.data?.outputs;
      if (
        rows.length !== OUTPUTS.length + 3 ||
        !scene?.ok ||
        !stage?.ok ||
        !listed?.ok ||
        (scene?.data?.currentProgramSceneName ?? scene?.data?.sceneName) !== policy.safeScene ||
        stage.data?.inputMuted !== true ||
        !outputs.every(outputInactive) ||
        !Array.isArray(list) ||
        !list.every(
          (output: unknown) =>
            typeof output === 'object' &&
            output &&
            'outputActive' in output &&
            output.outputActive === false,
        ) ||
        !unchanged()
      ) {
        invalidate('本机对白的 OBS 输出或宿主配置无法核对');
        return;
      }
      if (
        revision !== observedRevision ||
        !client.connected ||
        performance.now() >= started + OBS_SAMPLE_MS
      ) {
        invalidate('本机对白的 OBS 读回已失效');
        return;
      }
      const alreadyReady = ready();
      expiresAt = started + OBS_SAMPLE_MS;
      if (!alreadyReady)
        log('local_dialogue.obs-verified', {
          scene: policy.safeScene,
          stageMuted: true,
          activeOutputs: 0,
        });
    } catch {
      invalidate('本机对白的 OBS 读回失败');
    } finally {
      checking = false;
    }
  }
  const timer = setInterval(() => {
    if (!ready()) invalidated('本机对白的 OBS 读回已失效');
    void read();
  }, 125);
  timer.unref();
  void read();
  return {
    ready,
    close() {
      closed = true;
      clearInterval(timer);
      client?.close();
    },
  };
}

export async function startLocalGame(
  method: 'dialogue' | 'recovery' | 'named-choice',
  params: unknown,
  signal: AbortSignal,
  core: SafetyCore,
  sessionId: unknown,
  holder: string | undefined,
  game: Game | undefined,
) {
  const deny = (reason: string) => ({ ok: false as const, reason });
  const schema = {
    dialogue: isStart,
    recovery: isRecoveryStart,
    'named-choice': isNamedChoiceStart,
  }[method];
  const request = schema.Check(params) ? params : undefined;
  if (!request || !isSession.Check(sessionId) || !holder || !game || signal.aborted)
    return deny('本机游戏授权请求、会话或游戏桥不合法');
  const kind = 'kind' in request ? request.kind : undefined;
  const candidate = (status: ReturnType<Game['status']>) => {
    const health = status.health;
    const proof = health && 'localRecovery' in health ? health.localRecovery : undefined;
    if (!proof || proof.kind !== kind) return undefined;
    const point = status.decision;
    if (proof.kind === 'recover' || proof.kind === 'load') return point ? undefined : proof;
    if (
      point?.timing !== null ||
      status.health?.decisionPointId !== proof.decisionPointId ||
      point.decisionPointId !== proof.decisionPointId
    )
      return undefined;
    if (proof.kind !== 'named')
      return point.options.some(({ id }) => id === proof.optionId) ? proof : undefined;
    if (
      !('options' in request) ||
      point.options.length !== request.options.length ||
      !point.options.every(({ label }, index) => label === request.options[index]) ||
      proof.optionsDigest !== gameChoiceOptionsDigest(point.options)
    )
      return undefined;
    const selected = point.options[request.optionIndex];
    return selected ? { ...proof, optionId: selected.id } : undefined;
  };
  if (
    'options' in request &&
    (!request.options[request.optionIndex] ||
      new Set(request.options).size !== request.options.length)
  )
    return deny('指名选项不属于完整且无歧义的选项列表');
  const frameReadiness = (
    status: ReturnType<Game['status']>,
    now: number,
    expected?: ReturnType<typeof candidate>,
    accepted = false,
  ) => {
    const health = status.health;
    if (
      status.state !== 'READY' ||
      status.runtimeId !== request.runtimeId ||
      !status.mainConnected ||
      !status.coreConnected ||
      (!kind && status.decision) ||
      health?.ready !== true ||
      !health.prerequisites.some(({ id, confirmed }) => id === `local-${method}` && confirmed) ||
      health.atMs > now
    )
      return 'unavailable';
    if (!accepted && kind) {
      const proof = candidate(status);
      if (!proof) return 'pending';
      if (expected?.kind === 'named' && proof.kind === 'named') {
        if (
          proof.frameNumber < expected.frameNumber ||
          !isDeepStrictEqual({ ...proof, frameNumber: expected.frameNumber }, expected)
        )
          return 'unavailable';
      } else if (expected && !isDeepStrictEqual(proof, expected)) {
        return 'pending';
      }
    }
    return health.frameAgeMs !== null && now - health.atMs + health.frameAgeMs <= 500
      ? 'fresh'
      : 'pending';
  };
  let state = game.status();
  const readyBy = performance.now() + 2_500;
  while (
    frameReadiness(state, game.wireNowMs()) !== 'fresh' &&
    state.runtimeId === request.runtimeId &&
    state.state !== 'MANUAL' &&
    !state.health?.goalId &&
    !state.authority &&
    performance.now() < readyBy &&
    request.expiresAtMs - game.wireNowMs() > request.confirmationWindowMs
  ) {
    if (signal.aborted) return deny('本机游戏授权请求已取消');
    await delay(50, undefined, { signal });
    state = game.status();
  }
  if (
    frameReadiness(state, game.wireNowMs()) !== 'fresh' ||
    !state.adapter ||
    state.authority ||
    state.health?.goalId !== null ||
    core.store.intentsIn('unknown').length > 0
  )
    return deny(state.reason ?? '当前真实游戏或目标未就绪，或存在结果未明的意图');
  const expected = candidate(state);
  const common = {
    sessionId,
    runtimeId: request.runtimeId,
    adapterId: state.adapter.id,
    authorizationId: `local-${method}-${randomUUID()}`,
    expiresAtMs: request.expiresAtMs,
  };
  let recovery: GameLocalRecovery | undefined;
  if (expected) {
    recovery =
      expected.kind === 'recover'
        ? { ...common, ...expected, maxActions: 2 }
        : { ...common, ...expected, maxActions: 1 };
  }
  const dialogue: GameLocalDialogue | undefined =
    'maxActions' in request ? { ...common, maxActions: request.maxActions } : undefined;
  const scope = recovery ?? dialogue;
  if (!scope) return deny('Runtime 未确认所需的本机恢复入口');
  const activeScope = () => core.localRecovery ?? core.localDialogue;
  const permissionReadiness = (waitingMs = 0, accepted = false) => {
    const now = game.wireNowMs();
    const live = game.status();
    if (
      signal.aborted ||
      activeScope()?.authorizationId !== scope.authorizationId ||
      scope.expiresAtMs - now <= request.confirmationWindowMs + waitingMs ||
      !live.inputPermitted
    )
      return 'unavailable';
    return frameReadiness(live, now, expected, accepted);
  };
  if (
    scope.expiresAtMs - game.wireNowMs() <=
    request.confirmationWindowMs + LOCAL_DIALOGUE_GOAL_RPC_MS
  )
    return deny('本机游戏剩余动作核验时间不足');
  const nomination = 'nomination' in request ? request.nomination : undefined;
  const blocker =
    recovery?.kind === 'named'
      ? nomination && core.startLocalNamedChoice(holder, recovery, nomination)
      : recovery
        ? core.startLocalRecovery(holder, recovery)
        : core.startLocalDialogue(holder, scope);
  if (recovery?.kind === 'named' && !nomination) return deny('缺少本机选择的指名来源');
  if (blocker) return deny(blocker);
  let cancellation: ReturnType<SafetyCore['emergencyStop']> | undefined;
  const stopOnAbort = () => {
    cancellation = core.emergencyStop('本机游戏操作员请求已取消');
  };
  signal.addEventListener('abort', stopOnAbort, { once: true });
  let accepted = false;
  try {
    if (signal.aborted) {
      stopOnAbort();
      return deny('本机游戏操作员请求已取消');
    }
    const waitUntil = performance.now() + 5_000;
    while (
      permissionReadiness(LOCAL_DIALOGUE_GOAL_RPC_MS) !== 'fresh' &&
      performance.now() < waitUntil &&
      activeScope()
    )
      await delay(25, undefined, { signal });
    if (permissionReadiness(LOCAL_DIALOGUE_GOAL_RPC_MS) !== 'fresh')
      return deny('本机游戏许可未得到实时核确认或时间不足');
    const source = {
      origin: 'operator',
      inputs: [
        `local-${method}`,
        ...(nomination
          ? [nomination.source, nomination.approvalRef, nomination.nominationRef]
          : []),
      ],
      untrusted: false,
    } as const;
    const stillValid = () => permissionReadiness(LOCAL_DIALOGUE_GOAL_RPC_MS) === 'fresh';
    const objective =
      recovery?.kind === 'recover' || recovery?.kind === 'load'
        ? LOCAL_GOAL_OBJECTIVES[recovery.kind]
        : LOCAL_GOAL_OBJECTIVES.dialogue;
    const result =
      recovery &&
      (recovery.kind === 'prefix' || recovery.kind === 'untried' || recovery.kind === 'named')
        ? await game.resolveDecision(
            {
              decisionPointId: recovery.decisionPointId,
              optionId: recovery.optionId,
              source: 'operator',
              traceparent: null,
              localRecovery: recovery,
            },
            source,
            stillValid,
          )
        : await game.submitGoal(
            {
              goalId: scope.authorizationId,
              objective,
              constraints: recovery
                ? ['只执行已授权的游戏自带读取路径。', '画面或动作结果不明时停下。']
                : ['只单击推进当前普通对白或旁白。', '画面或动作结果不明时停下。'],
              mode: 'autonomous',
              decisionPointId: null,
              expiresAtMs: scope.expiresAtMs,
              traceparent: null,
              ...(recovery ? { localRecovery: recovery } : { localDialogue: scope }),
            },
            source,
            stillValid,
          );
    if (!result.ok) return deny(result.reason);
    if (result.duplicate) return deny('本机游戏意图重复');
    // 接纳回执可能先于下一次主连接健康上报。只等待同一许可下的新鲜判别。
    const refreshBy = performance.now() + 500;
    let readiness = permissionReadiness(0, true);
    while (readiness === 'pending' && performance.now() < refreshBy) {
      await delay(25, undefined, { signal });
      readiness = permissionReadiness(0, true);
    }
    if (readiness !== 'fresh') return deny('本机游戏命令回执后的画面或许可已失效');
    accepted = true;
    return { ok: true as const, ...scope };
  } finally {
    signal.removeEventListener('abort', stopOnAbort);
    if (!accepted) await (cancellation ?? core.emergencyStop('本机游戏命令未获有效回执'));
  }
}
