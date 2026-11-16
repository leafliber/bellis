import { randomUUID } from 'node:crypto';
import { ChannelError, type Connection } from '@bellis/channel';
import { defineService } from '@bellis/kernel';
import {
  GameBridgeRole,
  type OperatorGameOutcomeResolveParams,
  type OperatorGameTaskOpenParams,
} from '@bellis/protocol';

export type GameControlResult = { ok: true } | { ok: false; reason: string };

interface Endpoint {
  connect(role: GameBridgeRole, connection: Connection): void;
  takeOver(reason: string): void;
  returnControl(): GameControlResult;
  openTask?(params: OperatorGameTaskOpenParams): Promise<GameControlResult>;
  resolveOutcome?(params: OperatorGameOutcomeResolveParams): Promise<GameControlResult>;
}

/** 宿主交给插件的本机会话入口。操作员动作和认证密钥均留在宿主。 */
interface GameRuntimePort {
  readonly simulated: boolean;
  readonly sessionId: string;
  wireNowMs(): number;
  register(endpoint: Endpoint): () => void;
  emergencyStop(reason: string): void;
}

export const GameRuntimePortService = defineService<GameRuntimePort>('game-runtime-port', 1);

export class GameRuntimeHost {
  readonly port: GameRuntimePort;
  #endpoint: Endpoint | undefined;

  constructor(options: {
    /** 只用于注入无真实输入后端的仿真；常规宿主即使在 M0 也提供真实通道。 */
    simulated?: boolean;
    wireNowMs?: () => number;
    emergencyStop(reason: string): void;
  }) {
    this.port = {
      simulated: options.simulated ?? false,
      sessionId: randomUUID(),
      wireNowMs: options.wireNowMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
      emergencyStop: options.emergencyStop,
      register: (endpoint) => {
        if (this.#endpoint) throw new Error('游戏桥已注册本机连接');
        this.#endpoint = endpoint;
        return () => {
          if (this.#endpoint === endpoint) this.#endpoint = undefined;
        };
      },
    };
  }

  /** 仅由宿主在 R-05 双向认证之后调用。 */
  accept(connection: Connection): boolean {
    const role = connection.role;
    if (role !== GameBridgeRole.Main && role !== GameBridgeRole.Core) return false;
    if (!this.#endpoint) {
      connection.destroy(new ChannelError('protocol-error', '游戏桥尚未启用'));
    } else {
      this.#endpoint.connect(role, connection);
    }
    return true;
  }

  takeOver(reason = '操作员接管游戏'): GameControlResult {
    if (!this.#endpoint) return { ok: false, reason: '游戏桥尚未启用' };
    this.#endpoint.takeOver(reason);
    return { ok: true };
  }

  returnControl(): GameControlResult {
    return this.#endpoint?.returnControl() ?? { ok: false, reason: '游戏桥尚未启用' };
  }

  async openTask(params: OperatorGameTaskOpenParams): Promise<GameControlResult> {
    return this.#endpoint?.openTask?.(params) ?? { ok: false, reason: '游戏桥尚未启用任务入口' };
  }

  async resolveOutcome(params: OperatorGameOutcomeResolveParams): Promise<GameControlResult> {
    return (
      this.#endpoint?.resolveOutcome?.(params) ?? { ok: false, reason: '游戏桥尚未启用结案入口' }
    );
  }
}
