import { definePlugin, defineService } from '@bellis/kernel';
import type { ObsClient, ObsRequest } from '@bellis/obs';
import { SafetyService } from '@bellis/safety';
import type { Intent } from '@bellis/store';
import Type from 'typebox';

/** OBS 控制执行时持有的执行许可资源。 */
export const OBS_CONTROL = 'obs.control';

/**
 * 宿主提供的 OBS 连接：拿到的是已认证的连接，插件接触不到凭据。
 * 只有被授予 `obs.control` 权限的实例能连接；急停不走这条连接，走安全核自己的应急连接（D-30）。
 */
export interface ObsConnector {
  connect(): Promise<ObsClient>;
}

export const ObsConnectorService = defineService<ObsConnector>('obs.connector', 1);

/** OBS 控制能执行的动作，即意图的载荷。 */
export type ObsAction =
  | { kind: 'scene'; sceneName: string }
  | { kind: 'mute'; inputName: string; muted: boolean }
  /** 写来源设置，例如浏览器源的 url；只覆盖给出的键。 */
  | { kind: 'input-settings'; inputName: string; inputSettings: Record<string, unknown> };

/** 每种动作要求意图申请的能力（均不允许来自不可信输入，见安全核的 Rule of Two）。 */
export const OBS_ACTION_CAPABILITY = {
  scene: 'obs.scene',
  mute: 'obs.audio',
  'input-settings': 'obs.source',
} as const satisfies Record<ObsAction['kind'], string>;

export interface ObsControl {
  /** 与 OBS 的连接当前是否可用。 */
  readonly connected: boolean;
  /**
   * 执行一个已授权的意图，载荷即动作。按提交顺序逐个执行，每次都取得 OBS 控制许可、
   * 在发出请求前再核对一次，完成后交还。意图未申请动作所需的能力、拿不到许可、
   * OBS 不可用或拒绝请求时，意图以失败结束。
   */
  run(intent: Intent, action: ObsAction): Promise<Intent>;
}

export const ObsControlService = defineService<ObsControl>('obs.control', 1);

function toRequest(action: ObsAction): ObsRequest {
  switch (action.kind) {
    case 'scene':
      return {
        requestType: 'SetCurrentProgramScene',
        requestData: { sceneName: action.sceneName },
      };
    case 'mute':
      return {
        requestType: 'SetInputMute',
        requestData: { inputName: action.inputName, inputMuted: action.muted },
      };
    case 'input-settings':
      return {
        requestType: 'SetInputSettings',
        requestData: {
          inputName: action.inputName,
          inputSettings: action.inputSettings,
          overlay: true,
        },
      };
  }
}

/**
 * OBS 控制（关键平面）：经自己的 obs-websocket 连接切场景、静音源、写来源设置，
 * 每次操作都持有执行许可（见 Stage、OBS 与形象）。只执行别的插件已经授权的意图，
 * 不自己决定做什么；安全停止与维护态下拿不到许可，因此什么都不做。
 */
export const obsControl = definePlugin({
  manifest: {
    id: 'obs-control',
    version: '0.1.0',
    tier: 'critical',
    provides: [ObsControlService.ref],
    inject: [SafetyService.ref, ObsConnectorService.ref],
    permissions: ['obs.control'],
    process: 'in-process',
    config: Type.Object({
      /** 单个请求等待 OBS 应答的上限。 */
      requestTimeoutMs: Type.Integer({ minimum: 1, default: 1000 }),
    }),
  },
  activate(ctx) {
    const safety = ctx.service(SafetyService);
    const connector = ctx.service(ObsConnectorService);
    let client: ObsClient | undefined;
    let connecting: Promise<ObsClient> | undefined;
    /** 动作逐个执行：同一资源的许可每次授予都换新令牌，并发会让前一个动作的令牌失效。 */
    let queue: Promise<unknown> = Promise.resolve();

    const ensureClient = (): Promise<ObsClient> => {
      if (client?.connected) return Promise.resolve(client);
      connecting ??= connector
        .connect()
        .then((connected) => {
          client = connected;
          ctx.log('obs-control.connected');
          connected.onClose((reason) => ctx.log('obs-control.disconnected', { reason }));
          return connected;
        })
        .finally(() => {
          connecting = undefined;
        });
      return connecting;
    };
    void ensureClient().catch((error: unknown) =>
      ctx.log('obs-control.connect-failed', { error: (error as Error).message }),
    );
    // 停用时等在途动作做完再断开；收尾超时被强制时直接断开。
    ctx.register(async () => {
      if (!ctx.forced) await queue;
      client?.close();
    });

    const perform = async (intent: Intent, action: ObsAction) => {
      if (ctx.signal.aborted) throw new Error('OBS 控制正在停用');
      const capability = OBS_ACTION_CAPABILITY[action.kind];
      if (!intent.capabilities.includes(capability)) {
        throw new Error(`意图 ${intent.key} 没有申请 ${capability}`);
      }
      const granted = safety.grant(OBS_CONTROL);
      if (!granted.ok) throw new Error(`拿不到 OBS 控制许可：${granted.reason}`);
      const { lease } = granted;
      try {
        const obs = await ensureClient();
        if (ctx.signal.aborted) throw new Error('OBS 控制正在停用');
        if (!safety.isValid(OBS_CONTROL, lease.token)) throw new Error('OBS 控制许可已失效');
        const request = toRequest(action);
        const result = await obs.request(request.requestType, request.requestData, {
          timeoutMs: ctx.config.requestTimeoutMs,
        });
        if (!result.ok) {
          throw new Error(
            `OBS 拒绝 ${result.requestType}：${result.code}${result.comment ? ` ${result.comment}` : ''}`,
          );
        }
        return { requestType: result.requestType };
      } finally {
        safety.release(lease);
      }
    };

    const control: ObsControl = {
      get connected() {
        return client?.connected === true;
      },
      run(intent, action) {
        const next = queue.then(() =>
          safety.execute(intent, action, (checked) => perform(intent, checked)),
        );
        queue = next.catch(() => {});
        return next;
      },
    };
    ctx.provide(ObsControlService, control);
  },
});
