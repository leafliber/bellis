import { defineService } from '@bellis/kernel';

/**
 * `iris@1`：Iris 宿主接口 v1 中 Bellis 用到的部分（R-19）。提供方是只负责收发的 Iris 客户端插件
 * （`iris-client`，持有 `secret:iris`），仿真里是模拟 Iris（`iris-sim`）；使用方是记忆插件。
 * 字段按宿主接口契约（iris-core `docs/host-api.md`），这里用驼峰写法，由客户端换成契约的写法。
 * 收发的内容只当数据：客户端不解析成指令，隐私网关、墓碑与召回过滤都在记忆插件里。
 */

/** 写入 Iris 的一条消息（契约“接收消息与去重”的子集）。 */
export interface IrisMessage {
  platform: string;
  /** 显示名：观众用由平台身份派生的代号（见记忆插件），角色用 profile 里的名字。 */
  sender: string;
  /** 平台稳定 ID（B 站为 open_id）；角色自己的发言不带。 */
  accountId?: string;
  content: string;
  /** 带时区的 ISO 8601。 */
  occurredAt: string;
  /** 去重键：同一入口相同的键返回原消息；Bellis 持久保存，重试沿用原键。 */
  dedupeKey: string;
  /** `message`：别人说的话（观众声称）；`self_output`：角色自己说出口的话；`event`：入口建立的事件。 */
  kind: 'message' | 'self_output' | 'event';
  /** 首次创建入口时用：名字、类型与学习节奏；之后 Iris 沿用已保存的值。 */
  entryName?: string;
  entryKind?: string;
  pace?: 'realtime' | 'standard' | 'economy';
}

export interface IrisWriteResult {
  /** 按输入顺序的消息 ID；重复的去重键给出原消息的 ID。 */
  messageIds: number[];
  pendingCount: number;
}

/** 召回准备（`prepare`）的参数。人物要点、人物摘要、近期原始消息与目标都不取（P2 只召回公开事实）。 */
export interface IrisPrepareRequest {
  /** 查询提示；省略时 Iris 用本入口的近期消息自己构造。 */
  text?: string;
  /** 召回判断：P2 关闭（false），或把预算压短。 */
  judge: boolean;
  /** 召回判断的预算（秒，只能缩短缺省的 10 秒）；不给就不发。 */
  judgeBudgetSeconds?: number;
  /** 0–8；0 表示只取人设，不取记忆。 */
  memoryLimit: number;
  /** 0–1500。 */
  tokenBudget: number;
}

/** 召回的一条记忆（契约的 memory 对象中 Bellis 用到的字段；其余字段忽略）。 */
export interface IrisMemory {
  id: number;
  content: string;
  kind?: string;
  stance?: string;
  /** 说话人的显示名（Iris 按写入时的 sender 记）。 */
  speakerName?: string;
  /** 记忆涉及的主体。 */
  about: Array<{ id: string; name: string }>;
  /** 来源消息；来源入口不在令牌范围内时 `entryId` 为 null。 */
  sources: Array<{ messageId: number; entryId: string | null }>;
}

/**
 * 召回准备的 `persona` 分区中 Bellis 用到的部分：当前角色描述的正文与版本号。分区里的更新提示
 * （`needs_update`、`stale_basis_count`）不取。人设是角色全局的，任一入口返回同一份。
 */
export interface IrisPersona {
  content: string;
  /** 版本号；Iris 没有给出时为 null。 */
  version: number | null;
}

export interface IrisRecall {
  /** 使用反馈用的召回标识，有效 24 小时，属于发起它的令牌。 */
  recallId: string;
  memories: IrisMemory[];
  /** 当前人设；分区缺失或不合约定时没有。 */
  persona?: IrisPersona;
  /** 召回判断的状态（例如 `disabled`），只用于记录。 */
  judgment?: string;
}

export interface IrisFeedbackResult {
  accepted: number[];
  strengthened: number[];
}

/** `GET /status` 中 Bellis 关心的部分：服务状态（例如 `ready`）。 */
export interface IrisStatus {
  service: string;
}

/**
 * 失败的类别：401 `auth`；403 `forbidden`；404 `not_found`；409 `conflict`；413 `too_large`；其余 4xx `invalid`；
 * 429 `rate_limit`；503 `unavailable`；其余 5xx `server`；超时 `timeout`；连接失败或读取中断 `network`；
 * 返回不合约定 `protocol`；调用方取消 `aborted`。
 */
export type IrisErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'invalid'
  | 'rate_limit'
  | 'unavailable'
  | 'server'
  | 'timeout'
  | 'network'
  | 'protocol'
  | 'aborted';

/** 说明里只有类别、HTTP 状态、错误码与出错的字段路径，不含 Iris 的说明文字与令牌。 */
export class IrisError extends Error {
  readonly kind: IrisErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  /** 429、503 时 Iris 建议的等待（毫秒）。 */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: IrisErrorKind,
    message: string,
    detail: { status?: number; code?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'IrisError';
    this.kind = kind;
    this.status = detail.status;
    this.code = detail.code;
    this.retryAfterMs = detail.retryAfterMs;
  }
}

/** 连续失败与最近一次失败（就绪判定用）。 */
export interface IrisFailures {
  consecutive: number;
  last?: { kind: IrisErrorKind; at: number; status?: number; code?: string };
}

export interface Iris {
  /** 写入 1–1000 条消息，整批原子；不做隐式重试。 */
  write(
    entryId: string,
    messages: readonly IrisMessage[],
    signal: AbortSignal,
  ): Promise<IrisWriteResult>;
  /** 召回准备；调用方给截止时间（中止信号）。 */
  prepare(entryId: string, request: IrisPrepareRequest, signal: AbortSignal): Promise<IrisRecall>;
  /** 使用反馈：实际用到的记忆，没有用到就是空集。 */
  feedback(
    recallId: string,
    memoryIds: readonly number[],
    signal: AbortSignal,
  ): Promise<IrisFeedbackResult>;
  /** `GET /status`：能以宿主令牌访问（开播预检用）。 */
  check(signal: AbortSignal): Promise<IrisStatus>;
  /** 就绪：最近的请求没有处在连续失败中，也没有鉴权失败。判定不发请求。 */
  readonly ready: boolean;
  /** 给操作员看的状态说明：只含失败的类别、HTTP 状态与错误码。 */
  readonly status: string;
  readonly failures: IrisFailures;
}

export const IrisService = defineService<Iris>('iris', 1);

/**
 * 入口 ID 为什么不合法；合法时返回 undefined。契约（“鉴权与入口范围”）：长 1–200 个字符，不能全为空白，
 * 不含 `?`、`#` 与控制字符。Bellis 另外不用 `/`、`\` 与 `%`：入口 ID 在路径里，服务端按解码后的路径路由。
 */
export function entryIdBlocker(entryId: string): string | undefined {
  const length = [...entryId].length;
  if (length < 1 || length > 200) return '入口 ID 须为 1–200 个字符';
  if (entryId.trim() === '') return '入口 ID 不能全为空白';
  if (/[?#\p{Cc}]/u.test(entryId)) return '入口 ID 不能含 ?、# 或控制字符';
  if (/[/\\%]/.test(entryId)) return '入口 ID 不能含 /、\\ 或 %';
  return undefined;
}

/** 失败的类别、HTTP 状态与错误码，例如 `auth，HTTP 401，invalid_token`。 */
export function irisFailureText(failure: {
  kind: IrisErrorKind;
  status?: number | undefined;
  code?: string | undefined;
}): string {
  return [failure.kind, failure.status === undefined ? undefined : `HTTP ${failure.status}`]
    .concat(failure.code === undefined ? [] : [failure.code])
    .filter((part) => part !== undefined)
    .join('，');
}
