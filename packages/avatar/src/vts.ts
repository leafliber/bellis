import {
  ClockService,
  definePlugin,
  defineService,
  SecretsService,
  secretPermission,
  type TimerHandle,
} from '@bellis/kernel';
import { producesOutput, SafetyService } from '@bellis/safety';
import { StageService } from '@bellis/stage';
import type { Intent } from '@bellis/store';
import Type from 'typebox';
import { VtsClient, VtsErrorId, type VtsResponse } from './client.ts';
import { MouthTracker } from './mouth.ts';

/** VTS 插件令牌在 SecretStore 中的条目名，权限为 `secret:vts`。 */
export const VTS_SECRET = 'vts';
/** 触发表情的意图须申请的能力。 */
export const AVATAR_EXPRESSION = 'avatar.expression';
/** VTS 把令牌与插件名、开发者名绑定，改名即须重新在 VTS 中允许；两者都须为 3–32 个字符。 */
export const VTS_PLUGIN_NAME = 'Bellis';
export const VTS_PLUGIN_DEVELOPER = 'Bellis project';
/** 令牌的长度上限（VTS 的令牌不超过 64 个 ASCII 字符，这里放宽，只挡明显不对的应答）。 */
const MAX_TOKEN_LENGTH = 1024;

export interface Avatar {
  /** 已连上 VTube Studio 并认证，且嘴型参数可写（开播预检用）。 */
  readonly ready: boolean;
  /** 当前状态的说明，供开播预检与操作员查看；不含令牌。 */
  readonly status: string;
  /**
   * 触发一个表情：执行已授权的意图，载荷为 `{ expression: 表情名 }`，意图须申请 `avatar.expression`。
   * 表情名经插件配置映射到 VTS 热键 ID，以 HotkeyTriggerRequest 触发。未申请能力、没有配置该表情、
   * 已进入安全停止、VTS 未就绪或拒绝时，意图以失败结束；载荷与授权时不一致则抛错。
   */
  expression(intent: Intent, name: string): Promise<Intent>;
}

export const AvatarService = defineService<Avatar>('avatar', 1);

/**
 * 形象（普通插件）：经 VTube Studio 插件 API 驱动口型与表情（R-15）。
 *
 * - 插件令牌经凭据服务读写 `vts` 条目。没有令牌或令牌被拒时发令牌申请，VTS 弹窗由维护者点允许，
 *   拿到后写回再认证；维护者拒绝后本实例不再申请。令牌的值不进日志与事件。
 * - 按 Stage 的播放游标与响度包络，以固定频率注入嘴型参数（`set` 模式，声明已检测到面部）；
 *   取位置时推迟（Stage 的呈现延迟 − k_mouth），与声音对齐（Stage 文档“对齐”）；
 *   不说话时照常注入 0，满足 VTS 每个参数至少每秒重发一次的要求，宿主失联后 VTS 约 1 秒内收回控制。
 * - VTS 报告参数被其他插件占用时，记录事实并停止注入，不重试抢占。
 * - VTS 不在或断开时保持激活、报告未就绪，按固定间隔重连。
 */
export const vtsAvatar = definePlugin({
  manifest: {
    id: 'avatar-vts',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [AvatarService.ref],
    inject: [ClockService.ref, SafetyService.ref, StageService.ref, SecretsService.ref],
    permissions: [secretPermission(VTS_SECRET)],
    process: 'in-process',
    config: Type.Object({
      /** VTS 插件 API 的地址；只连本机，端口可在 VTS 中修改。 */
      url: Type.String({
        pattern: '^ws://127\\.0\\.0\\.1:[0-9]{1,5}$',
        default: 'ws://127.0.0.1:8001',
      }),
      /** 嘴型参数的注入频率。 */
      rateHz: Type.Integer({ minimum: 30, maximum: 60, default: 30 }),
      /** 嘴型参数：VTS 的输入参数 ID。 */
      mouthParameter: Type.String({ minLength: 1, maxLength: 64, default: 'MouthOpen' }),
      /** 响度包络的 RMS（相对 16 位满幅）不高于它即闭嘴。 */
      rmsFloor: Type.Number({ minimum: 0, maximum: 1, default: 0.01 }),
      /** RMS 不低于它即全开；其间线性。 */
      rmsCeiling: Type.Number({ minimum: 0, maximum: 1, default: 0.2 }),
      /** 两次游标回报之间按墙钟外推的上限。 */
      extrapolateMaxMs: Type.Integer({ minimum: 0, maximum: 200, default: 200 }),
      /**
       * k_mouth：口型从注入到出现在 OBS 画面里比字幕多出的时延。口型推迟（呈现延迟 − k_mouth），不小于 0；
       * 缺省值与重标方法见 Stage 文档“对齐”。
       */
      kMouthMs: Type.Integer({ minimum: 0, maximum: 300, default: 40 }),
      /** 连接失败或断开后的重连间隔。 */
      reconnectMs: Type.Integer({ minimum: 100, default: 3000 }),
      /** 建立连接与普通请求等待 VTS 的上限。 */
      requestTimeoutMs: Type.Integer({ minimum: 1, default: 2000 }),
      /** 令牌申请等维护者在 VTS 弹窗中点允许的上限。 */
      approvalTimeoutMs: Type.Integer({ minimum: 1, default: 300_000 }),
      /** 表情名到 VTS 热键 ID 的映射。 */
      expressions: Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), {
        default: {},
      }),
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const safety = ctx.service(SafetyService);
    const stage = ctx.service(StageService);
    const secrets = ctx.service(SecretsService);
    const config = ctx.config;
    const parameter = config.mouthParameter;
    const period = 1000 / config.rateHz;
    const plugin = { pluginName: VTS_PLUGIN_NAME, pluginDeveloper: VTS_PLUGIN_DEVELOPER };
    const mouth = new MouthTracker(config, (sentenceId) => stage.envelope(sentenceId));

    /** 已认证的会话。 */
    let client: VtsClient | undefined;
    /** 正在建立或认证的连接。 */
    let opening: VtsClient | undefined;
    let connecting = false;
    let awaitingApproval = false;
    let denied = false;
    /** 停止注入的原因（参数被占用或 VTS 拒绝注入）；本实例内不再注入。 */
    let halted: string | undefined;
    let lastError: string | undefined;
    let disposed = false;
    let retry: TimerHandle | undefined;
    let ticker: TimerHandle | undefined;
    let nextTick = 0;

    const stopped = () => disposed || ctx.signal.aborted;

    const status = (): string => {
      if (denied) return '维护者在 VTube Studio 中拒绝了插件；重新加载插件后才会再次申请';
      if (halted) return halted;
      if (client) return '就绪';
      if (awaitingApproval) return '等待维护者在 VTube Studio 中允许插件';
      return lastError ? `未连接 VTube Studio（${lastError}）` : '未连接 VTube Studio';
    };

    ctx.register(stage.onEvent((event) => mouth.onEvent(event, clock.now())));

    const stopTicking = () => {
      if (ticker) clock.clearTimeout(ticker);
      ticker = undefined;
    };

    const halt = (response: { errorId: number; message: string }) => {
      stopTicking();
      const occupied = response.errorId === VtsErrorId.InjectDataParamControlledByOtherPlugin;
      halted = occupied
        ? `参数 ${parameter} 已被其他插件占用`
        : `注入参数 ${parameter} 被拒绝：${response.errorId} ${response.message}`;
      const fields = { parameter, errorId: response.errorId, reason: halted };
      safety.record('avatar.injection-stopped', fields);
      ctx.log('avatar.injection-stopped', { ...fields, message: response.message });
    };

    const inject = (session: VtsClient, value: number) => {
      session
        .request(
          'InjectParameterDataRequest',
          { faceFound: true, mode: 'set', parameterValues: [{ id: parameter, value }] },
          config.requestTimeoutMs,
        )
        .then(
          (response) => {
            if (response.ok || halted || client !== session) return;
            if (response.errorId === VtsErrorId.RequestRequiresAuthentication) {
              // 用户在 VTS 中撤销了插件：断开后重连，重新认证（令牌被拒时再申请）。
              ctx.log('avatar.unauthenticated', { message: response.message });
              session.close();
              return;
            }
            halt(response);
          },
          () => {
            // 连接关闭由 onClose 处理；单次应答超时不影响后续注入。
          },
        );
    };

    const tick = () => {
      ticker = undefined;
      const session = client;
      if (!session || halted || stopped()) return;
      inject(session, mouth.value(clock.now(), stage.presentation.delayMs - config.kMouthMs));
      const now = clock.now();
      // 按绝对时刻排下一次，避免漂移；落后时不补发。
      nextTick = Math.max(nextTick + period, now);
      ticker = clock.setTimeout(tick, nextTick - now);
    };

    const startTicking = () => {
      if (ticker || halted) return;
      nextTick = clock.now();
      tick();
    };

    const scheduleReconnect = () => {
      if (stopped() || denied || retry || connecting || client) return;
      retry = clock.setTimeout(() => {
        retry = undefined;
        void connect();
      }, config.reconnectMs);
    };

    /** 用令牌认证本次会话；VTS 认为令牌无效时返回原因。 */
    const authenticateWith = async (
      session: VtsClient,
      token: string,
    ): Promise<{ authenticated: boolean; reason: string }> => {
      const response = await session.request(
        'AuthenticationRequest',
        { ...plugin, authenticationToken: token },
        config.requestTimeoutMs,
      );
      if (!response.ok) throw new Error(`认证请求被拒：${response.errorId} ${response.message}`);
      if (response.messageType !== 'AuthenticationResponse') {
        throw new Error(`认证的应答类型不对：${response.messageType}`);
      }
      return {
        authenticated: response.data.authenticated === true,
        reason: typeof response.data.reason === 'string' ? response.data.reason : '',
      };
    };

    const authenticate = async (session: VtsClient) => {
      const stored = await secrets.read(VTS_SECRET);
      if (stored !== undefined) {
        const result = await authenticateWith(session, stored);
        if (result.authenticated) return;
        ctx.log('avatar.token-rejected', { reason: result.reason });
      }
      if (stopped()) throw new Error('插件正在停用');
      // VTS 弹窗，应答要等维护者点允许或拒绝。
      awaitingApproval = true;
      ctx.log('avatar.token-requested');
      let response: VtsResponse;
      try {
        response = await session.request(
          'AuthenticationTokenRequest',
          plugin,
          config.approvalTimeoutMs,
        );
      } finally {
        awaitingApproval = false;
      }
      if (!response.ok) {
        if (response.errorId === VtsErrorId.TokenRequestDenied) {
          denied = true;
          ctx.log('avatar.token-denied');
        }
        throw new Error(`令牌申请被拒：${response.errorId} ${response.message}`);
      }
      const token = response.data.authenticationToken;
      if (
        response.messageType !== 'AuthenticationTokenResponse' ||
        typeof token !== 'string' ||
        token.length === 0 ||
        token.length > MAX_TOKEN_LENGTH
      ) {
        throw new Error('VTube Studio 返回的令牌不合法');
      }
      await secrets.write(VTS_SECRET, token);
      ctx.log('avatar.token-saved');
      const result = await authenticateWith(session, token);
      if (!result.authenticated) throw new Error(`新令牌未通过认证：${result.reason}`);
    };

    const connect = async () => {
      if (stopped() || connecting || client) return;
      connecting = true;
      try {
        const session = await VtsClient.connect(config.url, clock, config.requestTimeoutMs);
        opening = session;
        if (stopped()) throw new Error('插件正在停用');
        session.onClose((reason) => {
          if (client !== session) return;
          client = undefined;
          stopTicking();
          ctx.log('avatar.disconnected', { reason });
          scheduleReconnect();
        });
        await authenticate(session);
        if (stopped()) throw new Error('插件正在停用');
        if (!session.connected) throw new Error('VTube Studio 连接已关闭');
        client = session;
        lastError = undefined;
        ctx.log('avatar.authenticated');
        startTicking();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // VTS 不在时每次重连都失败，原因不变就不重复记日志。
        if (message !== lastError) ctx.log('avatar.connect-failed', { error: message });
        lastError = message;
        opening?.close();
      } finally {
        opening = undefined;
        connecting = false;
      }
      if (!client) scheduleReconnect();
    };

    ctx.register(() => {
      disposed = true;
      if (retry) clock.clearTimeout(retry);
      retry = undefined;
      stopTicking();
      const session = client;
      client = undefined;
      // 断开后 VTS 收回参数，口型归位。
      session?.close();
      opening?.close();
    });

    const avatar: Avatar = {
      get ready() {
        return client !== undefined && halted === undefined;
      },
      get status() {
        return status();
      },
      expression(intent, name) {
        return safety.execute(intent, { expression: name }, async ({ expression }) => {
          if (!intent.capabilities.includes(AVATAR_EXPRESSION)) {
            throw new Error(`意图 ${intent.key} 没有申请 ${AVATAR_EXPRESSION}`);
          }
          const hotkeyID = Object.hasOwn(config.expressions, expression)
            ? config.expressions[expression]
            : undefined;
          if (hotkeyID === undefined) throw new Error(`没有配置表情 ${expression}`);
          if (stopped()) throw new Error('形象插件正在停用');
          // 授权之后可能已进入安全停止：发出前再核对一次。
          if (!producesOutput(safety.mode)) throw new Error('安全停止中，不触发表情');
          const session = client;
          if (!session) throw new Error(`VTube Studio 未就绪：${status()}`);
          const response = await session.request(
            'HotkeyTriggerRequest',
            { hotkeyID },
            config.requestTimeoutMs,
          );
          if (!response.ok) {
            throw new Error(
              `VTube Studio 拒绝触发热键 ${hotkeyID}：${response.errorId} ${response.message}`,
            );
          }
          return { hotkeyID };
        });
      },
    };
    ctx.provide(AvatarService, avatar);
    void connect();
  },
});
