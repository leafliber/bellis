import { type Clock, type TimerHandle, withDeadline } from '@bellis/kernel';
import { ApiError, ErrorCode, type GameSession, type OpenApi } from './api.ts';
import { type LinkCommand, LinkError, LiveLink } from './link.ts';
import { hostOf, linkBlocker } from './targets.ts';

/** 场次失效：平台不再向这一场推送消息（见观众接入文档）。 */
export const INTERACTION_END = 'LIVE_OPEN_PLATFORM_INTERACTION_END';

export interface ClientTimings {
  /** 开启场次、项目心跳的 HTTP 截止时间。 */
  httpTimeoutMs: number;
  /** 项目心跳间隔（平台要求 20 秒一次；互动玩法 60 秒、直播工具 180 秒收不到就关闭场次）。 */
  projectHeartbeatMs: number;
  /** 项目心跳连续失败这么多次（7003 除外，它一次就算）视为场次失效。 */
  projectHeartbeatFailures: number;
  connectTimeoutMs: number;
  authTimeoutMs: number;
  /** 长连接心跳间隔。 */
  heartbeatIntervalMs: number;
  /** 长连接这么久收不到任何包（含心跳回复）视为断开。 */
  idleTimeoutMs: number;
  /** 场次开了这么久就主动重开（平台说长连接超过 7 天可能收不到消息）。 */
  maxSessionAgeMs: number;
  /** 指数退避的起点与上限。 */
  backoffInitialMs: number;
  backoffMaxMs: number;
  /** 长连接稳定收了这么久才断开时，退避从头算起。 */
  stableAfterMs: number;
  /** 7001（上一局结算中）后等这么久再开。 */
  settlingRetryMs: number;
  /** 7002（已有场次或上一场没有正常结束）、7010（连接数超限）后等这么久再开。 */
  occupiedRetryMs: number;
  /** 鉴权或配置类错误（IP 白名单、访问受限、未上架应用连了别人的直播间、没有可连的地址）后等这么久再试。 */
  blockedRetryMs: number;
  /** 关闭场次的截止时间（停用时也用它）。 */
  endTimeoutMs: number;
  /** 单条 WebSocket 消息的上限。 */
  maxPayloadBytes: number;
}

export interface Gap {
  /** 缺口开始的原因。 */
  reason: string;
  /** 缺口开始的墙钟时刻（毫秒）。 */
  startedAt: number;
}

export interface GapEnd extends Gap {
  endedAt: number;
  durationMs: number;
  /** false 表示缺口因停用而结束，并没有恢复接收。 */
  recovered: boolean;
}

/** 客户端交出的东西：业务消息（场次失效除外）与缺口。 */
export interface ClientSink {
  /** `receivedAt` 为本机收到时的墙钟时刻（毫秒）。 */
  command(command: LinkCommand, receivedAt: number): void;
  gapStarted(gap: Gap): void;
  gapEnded(gap: GapEnd): void;
}

export interface ClientOptions extends ClientTimings {
  api: OpenApi;
  appId: number;
  /** 主播身份码；不写日志。 */
  code: string;
  /** profile 授予的权限：连接长连接地址前逐个核对主机。 */
  permissions: ReadonlySet<string>;
  clock: Clock;
  /** 墙钟（毫秒）：缺口与收到消息的时刻。 */
  wallNow: () => number;
  log: (event: string, fields: Record<string, unknown>) => void;
  sink: ClientSink;
}

export type ClientState =
  | 'idle'
  | 'opening'
  | 'waiting'
  | 'connecting'
  | 'receiving'
  | 'reopening'
  | 'stopping'
  | 'stopped';

interface Outcome {
  reason: string;
  /** 重开前等多久；缺省按指数退避。 */
  delayMs?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * B 站直播开放平台的接入客户端：开启场次 → 项目心跳 → 长连接（认证、心跳、解包、地址轮换）→ 场次失效时关闭并重开。
 * 只负责收发：收到的消息原样交给 {@link ClientSink}，不当作指令解析。
 *
 * - **场次**：开启失败按错误码等待（7001 约 10 秒、7002 一分钟以上、鉴权与配置类较久），其余按指数退避；
 *   项目心跳返回 7003 或连续失败、收到 `INTERACTION_END`、场次开得太久、长连接认证被拒或地址都连不上时，
 *   关闭旧场次（能关就关）后重新开启。无场次编号（`game_id` 为空串）的场次不发项目心跳、不关闭，只靠长连接维持，
 *   `INTERACTION_END` 不按编号过滤。
 * - **长连接**：返回的地址依次使用，一个连不上就换下一个；断开后按退避重连。只连 profile 授予了外发的主机。
 * - **缺口**：从失去接收（断开、认证失败、心跳失败、场次失效、开启失败）到长连接重新认证成功之间是缺口，
 *   开始与结束都交给 sink；停用时仍开着的缺口以“未恢复”结束。
 * - 一切计时都经过注入的时钟。日志只写编号、主机、计数、状态与原因，不写 auth_body、身份码与密钥。
 */
export class BilibiliClient {
  readonly #options: ClientOptions;
  readonly #stop = new AbortController();
  #running: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  #state: ClientState = 'idle';
  #reason: string | undefined;
  #game: GameSession | undefined;
  #link: LiveLink | undefined;
  #gap: (Gap & { startedClock: number }) | undefined;
  #failures = 0;
  #everReady = false;
  #startedAt = 0;
  #startedClock = 0;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  get state(): ClientState {
    return this.#state;
  }

  /** 当前状态的说明（等待的原因、所连的主机等）。 */
  get status(): string {
    return this.#reason ? `${this.#state}：${this.#reason}` : this.#state;
  }

  /** 正在接收：长连接已认证。 */
  get receiving(): boolean {
    return this.#state === 'receiving';
  }

  /** 在后台开启场次与长连接；立即返回。 */
  start(): void {
    if (this.#running || this.#stop.signal.aborted) return;
    this.#startedAt = this.#options.wallNow();
    this.#startedClock = this.#options.clock.now();
    this.#running = this.#run().catch((error: unknown) => {
      this.#log('bilibili.client-crashed', { error: errorText(error) });
    });
  }

  /** 停心跳、关长连接、关闭场次；都带截止时间，失败只记日志。可重复调用。 */
  stop(): Promise<void> {
    this.#stopping ??= this.#shutdown();
    return this.#stopping;
  }

  async #shutdown(): Promise<void> {
    const { clock, endTimeoutMs } = this.#options;
    this.#setState('stopping', undefined);
    this.#stop.abort();
    this.#link?.close('停用');
    if (this.#running) {
      try {
        await withDeadline(clock, this.#running, endTimeoutMs + 1000, '接入客户端收尾');
      } catch (error) {
        this.#log('bilibili.stop-timeout', { error: errorText(error) });
      }
    }
    await this.#endGame('停用');
    this.#closeGap(false);
    this.#setState('stopped', undefined);
  }

  async #run(): Promise<void> {
    const { api, appId, code } = this.#options;
    const signal = this.#stop.signal;
    while (!signal.aborted) {
      this.#setState('opening', undefined);
      let session: GameSession;
      try {
        session = await api.start(code, appId, signal);
      } catch (error) {
        if (signal.aborted) break;
        const failure = this.#startFailure(error);
        this.#openGap(failure.reason);
        this.#log('bilibili.session-failed', {
          code: error instanceof ApiError ? error.code : undefined,
          requestId: error instanceof ApiError ? error.requestId : undefined,
          reason: failure.reason,
          retryInMs: failure.delayMs,
        });
        this.#setState('waiting', failure.reason);
        await this.#sleep(failure.delayMs, signal);
        continue;
      }
      this.#game = session;
      if (signal.aborted) break;
      this.#log('bilibili.session-opened', {
        gameId: session.gameId,
        roomId: session.roomId,
        links: session.links.length,
        ...(session.gameId === ''
          ? { noGameId: true, note: '无场次编号：不发项目心跳、不关闭场次，只靠长连接维持' }
          : {}),
      });
      const outcome = await this.#session(session);
      if (signal.aborted) break;
      this.#openGap(outcome.reason);
      this.#setState('reopening', outcome.reason);
      this.#log('bilibili.session-invalid', { gameId: session.gameId, reason: outcome.reason });
      await this.#endGame(outcome.reason);
      await this.#sleep(outcome.delayMs ?? this.#backoff(), signal);
    }
  }

  /** 一个场次：项目心跳、场次时长、长连接（轮换与重连）。场次失效或停用时返回。 */
  async #session(session: GameSession): Promise<Outcome> {
    const o = this.#options;
    const { clock } = o;
    const scope = new AbortController();
    const onStop = () => scope.abort();
    this.#stop.signal.addEventListener('abort', onStop, { once: true });
    let outcome: Outcome | undefined;
    const invalidate = (next: Outcome) => {
      if (outcome || this.#stop.signal.aborted) return;
      outcome = next;
      scope.abort();
      this.#link?.close(next.reason);
    };

    let heartbeat: TimerHandle | undefined;
    let heartbeatFailures = 0;
    const beat = async () => {
      heartbeat = undefined;
      if (scope.signal.aborted) return;
      try {
        await o.api.heartbeat(session.gameId, scope.signal);
        if (heartbeatFailures > 0) {
          this.#log('bilibili.heartbeat-recovered', {
            gameId: session.gameId,
            after: heartbeatFailures,
          });
        }
        heartbeatFailures = 0;
      } catch (error) {
        if (scope.signal.aborted) return;
        heartbeatFailures += 1;
        const code = error instanceof ApiError ? error.code : undefined;
        this.#log('bilibili.heartbeat-failed', {
          gameId: session.gameId,
          code,
          reason: errorText(error),
          consecutive: heartbeatFailures,
        });
        if (code === ErrorCode.GameExpired) {
          invalidate({ reason: `项目心跳失败：心跳过期或场次已关闭（${code}）` });
          return;
        }
        if (heartbeatFailures >= o.projectHeartbeatFailures) {
          invalidate({
            reason: `项目心跳连续失败 ${heartbeatFailures} 次：${errorText(error)}`,
          });
          return;
        }
      }
      if (!scope.signal.aborted)
        heartbeat = clock.setTimeout(() => void beat(), o.projectHeartbeatMs);
    };
    // 无场次编号（game_id 为空串）的场次不发项目心跳（与 blivedm 一致；PENDING，以真机为准）。
    if (session.gameId !== '') {
      heartbeat = clock.setTimeout(() => void beat(), o.projectHeartbeatMs);
    }
    const age = clock.setTimeout(() => {
      invalidate({ reason: `场次已开 ${Math.round(o.maxSessionAgeMs / 60_000)} 分钟，例行重开` });
    }, o.maxSessionAgeMs);

    const links: string[] = [];
    for (const link of session.links) {
      const blocked = linkBlocker(link, o.permissions);
      if (blocked) {
        this.#log('bilibili.host-skipped', {
          gameId: session.gameId,
          host: hostOf(link),
          reason: blocked,
        });
      } else links.push(link);
    }
    if (links.length === 0) {
      invalidate({
        reason: `没有可连接的长连接地址（返回 ${session.links.length} 个，均未授予或协议不对）`,
        delayMs: o.blockedRetryMs,
      });
    }

    let index = 0;
    let failedInRow = 0;
    const limit = Math.max(3, links.length * 2);
    try {
      while (!outcome && !scope.signal.aborted) {
        const url = links[index % links.length] as string;
        index += 1;
        const host = hostOf(url);
        this.#setState('connecting', host);
        this.#log('bilibili.link-connecting', { gameId: session.gameId, host });
        let link: LiveLink;
        try {
          link = await LiveLink.open(
            {
              url,
              authBody: session.authBody,
              clock,
              connectTimeoutMs: o.connectTimeoutMs,
              authTimeoutMs: o.authTimeoutMs,
              heartbeatIntervalMs: o.heartbeatIntervalMs,
              idleTimeoutMs: o.idleTimeoutMs,
              maxPayload: o.maxPayloadBytes,
              signal: scope.signal,
            },
            {
              command: (command) => this.#command(command, session, invalidate),
              malformed: (reason) =>
                this.#log('bilibili.malformed', { gameId: session.gameId, host, reason }),
            },
          );
        } catch (error) {
          if (outcome || scope.signal.aborted) break;
          failedInRow += 1;
          const reason = errorText(error);
          this.#openGap(`长连接 ${host} ${reason}`);
          this.#log('bilibili.link-failed', {
            gameId: session.gameId,
            host,
            reason,
            consecutive: failedInRow,
          });
          if (error instanceof LinkError && error.auth) {
            invalidate({ reason: `长连接认证失败：${reason}` });
            break;
          }
          if (failedInRow >= limit) {
            invalidate({ reason: `长连接连续 ${failedInRow} 次连不上` });
            break;
          }
          await this.#sleep(this.#backoff(), scope.signal);
          continue;
        }
        if (outcome || scope.signal.aborted) {
          link.close('场次已结束');
          break;
        }
        this.#link = link;
        failedInRow = 0;
        const readyAt = clock.now();
        this.#setState('receiving', host);
        this.#log('bilibili.link-ready', { gameId: session.gameId, host });
        this.#closeGap(true);
        const closed = await link.closed;
        this.#link = undefined;
        const readyMs = Math.round(clock.now() - readyAt);
        this.#log('bilibili.link-closed', {
          gameId: session.gameId,
          host,
          reason: closed,
          readyMs,
        });
        if (outcome || scope.signal.aborted) break;
        if (readyMs >= o.stableAfterMs) this.#failures = 0;
        this.#openGap(`长连接断开：${closed}`);
        await this.#sleep(this.#backoff(), scope.signal);
      }
    } finally {
      if (heartbeat) clock.clearTimeout(heartbeat);
      clock.clearTimeout(age);
      this.#stop.signal.removeEventListener('abort', onStop);
      scope.abort();
    }
    return outcome ?? { reason: '已停用' };
  }

  #command(
    command: LinkCommand,
    session: GameSession,
    invalidate: (outcome: Outcome) => void,
  ): void {
    if (command.cmd === INTERACTION_END) {
      const data = command.data as { game_id?: unknown } | null | undefined;
      const raw = data?.game_id;
      const gameId = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
      // 无场次编号的场次分不出是不是自己的，一律当作自己的：重开只多一小段缺口，漏判则一直收不到消息。
      if (session.gameId !== '' && gameId !== undefined && gameId !== session.gameId) {
        this.#log('bilibili.interaction-end-ignored', { gameId: session.gameId, other: gameId });
        return;
      }
      invalidate({ reason: '收到场次结束（INTERACTION_END）' });
      return;
    }
    try {
      this.#options.sink.command(command, this.#options.wallNow());
    } catch (error) {
      this.#log('bilibili.sink-failed', {
        cmd: command.cmd.slice(0, 64),
        error: error instanceof Error ? error.name : '未知',
      });
    }
  }

  /** 开启场次失败后等多久、缺口原因是什么。 */
  #startFailure(error: unknown): { delayMs: number; reason: string } {
    const o = this.#options;
    const text = errorText(error);
    const code = error instanceof ApiError ? error.code : undefined;
    switch (code) {
      case ErrorCode.Settling:
        return { delayMs: o.settlingRetryMs, reason: `开启场次失败，上一局还在结算：${text}` };
      case ErrorCode.Occupied:
        return {
          delayMs: o.occupiedRetryMs,
          reason: `开启场次失败，直播间已有场次或上一场没有正常结束：${text}`,
        };
      case ErrorCode.TooManyConnections:
        return { delayMs: o.occupiedRetryMs, reason: `开启场次失败，连接数超限：${text}` };
      case ErrorCode.IpWhitelist:
        return { delayMs: o.blockedRetryMs, reason: `开启场次失败，本机 IP 不在白名单：${text}` };
      case ErrorCode.AccessLimited:
        return { delayMs: o.blockedRetryMs, reason: `开启场次失败，访问受限：${text}` };
      case ErrorCode.RoomWhitelist:
      case ErrorCode.RoomWhitelist2:
        return {
          delayMs: o.blockedRetryMs,
          reason: `开启场次失败，未上架的应用只能连开发者自己的直播间（核对身份码）：${text}`,
        };
      case ErrorCode.NonceRepeated:
        return { delayMs: o.backoffInitialMs, reason: `开启场次失败，nonce 重复：${text}` };
      default:
        return { delayMs: this.#backoff(), reason: `开启场次失败：${text}` };
    }
  }

  /** 关闭场次：能关就关，带截止时间，失败只记日志。 */
  async #endGame(reason: string): Promise<void> {
    const game = this.#game;
    this.#game = undefined;
    if (!game) return;
    const o = this.#options;
    if (game.gameId === '') {
      // 无场次编号：没有可关闭的场次（与 blivedm 一致；PENDING，以真机为准）。
      this.#log('bilibili.end-skipped', { gameId: '', noGameId: true, reason });
      return;
    }
    try {
      // 不随停用中止：停用时正是要把场次关掉。
      await o.api.end(o.appId, game.gameId, new AbortController().signal, o.endTimeoutMs);
      this.#log('bilibili.session-ended', { gameId: game.gameId, reason });
    } catch (error) {
      this.#log('bilibili.end-failed', {
        gameId: game.gameId,
        reason,
        code: error instanceof ApiError ? error.code : undefined,
        error: errorText(error),
      });
    }
  }

  #openGap(reason: string): void {
    if (this.#gap) return;
    const { clock, wallNow } = this.#options;
    // 从没收到过：缺口从开始接入时算起。
    const startedAt = this.#everReady ? wallNow() : this.#startedAt;
    const startedClock = this.#everReady ? clock.now() : this.#startedClock;
    this.#gap = { reason, startedAt, startedClock };
    this.#log('bilibili.gap-started', { reason });
    this.#options.sink.gapStarted({ reason, startedAt });
  }

  #closeGap(recovered: boolean): void {
    if (recovered) this.#everReady = true;
    const gap = this.#gap;
    if (!gap) return;
    this.#gap = undefined;
    const { clock, wallNow } = this.#options;
    const durationMs = Math.max(0, Math.round(clock.now() - gap.startedClock));
    this.#log('bilibili.gap-ended', { reason: gap.reason, durationMs, recovered });
    this.#options.sink.gapEnded({
      reason: gap.reason,
      startedAt: gap.startedAt,
      endedAt: wallNow(),
      durationMs,
      recovered,
    });
  }

  #backoff(): number {
    const o = this.#options;
    const delay = Math.min(o.backoffMaxMs, o.backoffInitialMs * 2 ** this.#failures);
    this.#failures = Math.min(this.#failures + 1, 30);
    return delay;
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    const { clock } = this.#options;
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clock.clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = clock.setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  #setState(state: ClientState, reason: string | undefined): void {
    if (this.#state === state && this.#reason === reason) return;
    this.#state = state;
    this.#reason = reason;
  }

  #log(event: string, fields: Record<string, unknown>): void {
    this.#options.log(event, fields);
  }
}
