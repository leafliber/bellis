import type { LlmErrorKind, LlmFailures } from '@bellis/director';

/** 一次失败：类别、HTTP 状态与错误码（不含服务端的说明）。 */
export interface FailureFacts {
  kind: LlmErrorKind;
  status?: number | undefined;
  code?: string | undefined;
}

/** 失败的类别、HTTP 状态与错误码，例如 `auth，HTTP 401，AuthenticationError`；不含服务端的说明。 */
export function failureText(failure: FailureFacts): string {
  return [
    failure.kind,
    failure.status === undefined ? undefined : `HTTP ${failure.status}`,
    failure.code,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join('，');
}

/**
 * 模型客户端的就绪判定（见决策模型“就绪”）：不发请求，只看最近的调用。
 *
 * - 还没调用过，或连续失败少于 `unreadyAfter` 次：就绪；
 * - 连续失败达到 `unreadyAfter` 次：未就绪，直到下一次成功；
 * - 鉴权失败（`auth`）一出现就未就绪，直到下一次成功；
 * - 调用方取消（`aborted`）不算失败；截止时间到点由插件按 `timeout` 记。
 *
 * 状态说明只含类别、HTTP 状态与错误码，不含服务端的说明。
 */
export class LlmHealth {
  readonly #unreadyAfter: number;
  readonly #now: () => number;
  #calls = 0;
  #consecutive = 0;
  #authFailed = false;
  #last: { kind: LlmErrorKind; at: number; status?: number; code?: string } | undefined;

  /** `now` 为墙钟（毫秒），记最近一次失败的时刻。 */
  constructor(unreadyAfter: number, now: () => number = Date.now) {
    this.#unreadyAfter = unreadyAfter;
    this.#now = now;
  }

  succeeded(): void {
    this.#calls += 1;
    this.#consecutive = 0;
    this.#authFailed = false;
  }

  failed(failure: FailureFacts): void {
    if (failure.kind === 'aborted') return;
    this.#calls += 1;
    this.#consecutive += 1;
    if (failure.kind === 'auth') this.#authFailed = true;
    this.#last = {
      kind: failure.kind,
      at: this.#now(),
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.code === undefined ? {} : { code: failure.code }),
    };
  }

  get ready(): boolean {
    return !this.#authFailed && this.#consecutive < this.#unreadyAfter;
  }

  get status(): string {
    const last = this.#last;
    const n = this.#consecutive;
    if (this.#authFailed && last) return `鉴权失败（${failureText(last)}），下一次成功之前不就绪`;
    if (!this.ready && last) return `连续失败 ${n} 次（最近一次：${failureText(last)}）`;
    if (this.#calls === 0) return '就绪（还没有调用过）';
    if (n > 0 && last) return `就绪（连续失败 ${n} 次，最近一次：${failureText(last)}）`;
    return '就绪';
  }

  get failures(): LlmFailures {
    return {
      consecutive: this.#consecutive,
      ...(this.#last ? { last: { ...this.#last } } : {}),
    };
  }
}
