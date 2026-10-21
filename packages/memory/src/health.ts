import { type IrisError, type IrisFailures, irisFailureText } from './iris.ts';

/**
 * Iris 的就绪判定（与模型客户端的判定同一种写法）：不发请求，只看最近的请求。
 *
 * - 还没请求过，或连续失败少于 `unreadyAfter` 次：就绪；
 * - 连续失败达到 `unreadyAfter` 次：未就绪，直到下一次成功；
 * - 鉴权或权限失败（`auth`、`forbidden`）一出现就未就绪，直到下一次成功；
 * - 调用方取消（`aborted`）不算失败；内容被拒（`invalid`、`too_large`）是这一条消息的问题，不算 Iris 失败。
 *
 * 状态说明只含类别、HTTP 状态与错误码。
 */
export class IrisHealth {
  readonly #unreadyAfter: number;
  readonly #now: () => number;
  #requests = 0;
  #consecutive = 0;
  #denied = false;
  #last: IrisFailures['last'];

  /** `now` 为墙钟（毫秒），记最近一次失败的时刻。 */
  constructor(unreadyAfter: number, now: () => number = Date.now) {
    this.#unreadyAfter = unreadyAfter;
    this.#now = now;
  }

  succeeded(): void {
    this.#requests += 1;
    this.#consecutive = 0;
    this.#denied = false;
  }

  failed(error: Pick<IrisError, 'kind' | 'status' | 'code'>): void {
    if (error.kind === 'aborted' || error.kind === 'invalid' || error.kind === 'too_large') {
      if (error.kind !== 'aborted') this.#requests += 1;
      return;
    }
    this.#requests += 1;
    this.#consecutive += 1;
    if (error.kind === 'auth' || error.kind === 'forbidden') this.#denied = true;
    this.#last = {
      kind: error.kind,
      at: this.#now(),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.code === undefined ? {} : { code: error.code }),
    };
  }

  get ready(): boolean {
    return !this.#denied && this.#consecutive < this.#unreadyAfter;
  }

  get status(): string {
    const last = this.#last;
    const n = this.#consecutive;
    if (this.#denied && last) return `鉴权失败（${irisFailureText(last)}），下一次成功之前不就绪`;
    if (!this.ready && last) return `连续失败 ${n} 次（最近一次：${irisFailureText(last)}）`;
    if (this.#requests === 0) return '就绪（还没有请求过）';
    if (n > 0 && last) return `就绪（连续失败 ${n} 次，最近一次：${irisFailureText(last)}）`;
    return '就绪';
  }

  get failures(): IrisFailures {
    return { consecutive: this.#consecutive, ...(this.#last ? { last: { ...this.#last } } : {}) };
  }
}
