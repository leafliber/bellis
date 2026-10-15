/**
 * 扩展点与五种分发模式。扩展点在定义时声明模式，只能按该模式分发。
 *
 * | 模式 | 执行方式 | 返回值 | 异常 |
 * | observe 观察 | 按注册顺序同步调用，不等待异步监听者 | 无 | 捕获并记录 |
 * | wrap 包装 | 环绕中间件，调用 next 交给下游，不调用即短路 | 有 | 抛给调用方 |
 * | parallel 并行 | 并发调用并等待全部结束 | 无 | 收集后一并抛出 |
 * | serial 串行 | 按注册顺序逐个等待，第一个非空返回值生效 | 有 | 抛给调用方 |
 * | first 首个决定 | 同串行，但只允许同步监听者 | 有 | 抛给调用方 |
 */
export type DispatchMode = 'observe' | 'wrap' | 'parallel' | 'serial' | 'first';

export interface HandlerFor<A, R> {
  observe: (args: A) => unknown;
  wrap: (args: A, next: (args: A) => Promise<R>) => Promise<R>;
  parallel: (args: A) => void | Promise<void>;
  serial: (args: A) => R | undefined | Promise<R | undefined>;
  first: (args: A) => R | undefined;
}

export interface Extension<M extends DispatchMode, A, R = void> {
  readonly name: string;
  readonly mode: M;
  /** 只用于类型推断。 */
  readonly _types?: (args: A) => R;
}

export type Handler<E> =
  E extends Extension<infer M, infer A, infer R> ? HandlerFor<A, R>[M] : never;

export function defineExtension<M extends DispatchMode, A, R = void>(
  name: string,
  mode: M,
): Extension<M, A, R> {
  return { name, mode };
}

type AnyHandler = (...args: never[]) => unknown;

export class Extensions {
  readonly #points = new Map<string, { mode: DispatchMode; handlers: AnyHandler[] }>();
  readonly #onObserveError: (name: string, error: unknown) => void;

  constructor(onObserveError: (name: string, error: unknown) => void) {
    this.#onObserveError = onObserveError;
  }

  /** 注册监听者，返回撤销函数。 */
  add<E extends Extension<DispatchMode, never, unknown>>(
    extension: E,
    handler: Handler<E>,
  ): () => void {
    const point = this.#point(extension);
    const fn = handler as AnyHandler;
    point.handlers.push(fn);
    return () => {
      const index = point.handlers.indexOf(fn);
      if (index >= 0) point.handlers.splice(index, 1);
    };
  }

  observe<A>(extension: Extension<'observe', A>, args: A): void {
    for (const handler of this.#snapshot(extension) as Array<HandlerFor<A, void>['observe']>) {
      try {
        const result = handler(args);
        if (isThenable(result)) {
          result.then(undefined, (error: unknown) => this.#onObserveError(extension.name, error));
        }
      } catch (error) {
        this.#onObserveError(extension.name, error);
      }
    }
  }

  wrap<A, R>(
    extension: Extension<'wrap', A, R>,
    args: A,
    inner: (args: A) => Promise<R>,
  ): Promise<R> {
    const handlers = this.#snapshot(extension) as Array<HandlerFor<A, R>['wrap']>;
    const run = async (index: number, value: A): Promise<R> => {
      const handler = handlers[index];
      return handler ? handler(value, (next) => run(index + 1, next)) : inner(value);
    };
    return run(0, args);
  }

  async parallel<A>(extension: Extension<'parallel', A>, args: A): Promise<void> {
    const handlers = this.#snapshot(extension) as Array<HandlerFor<A, void>['parallel']>;
    const results = await Promise.allSettled(handlers.map(async (handler) => handler(args)));
    const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (errors.length > 0)
      throw new AggregateError(errors, `${extension.name} 有 ${errors.length} 个监听者失败`);
  }

  async serial<A, R>(extension: Extension<'serial', A, R>, args: A): Promise<R | undefined> {
    for (const handler of this.#snapshot(extension) as Array<HandlerFor<A, R>['serial']>) {
      const result = await handler(args);
      if (result !== undefined && result !== null) return result;
    }
    return undefined;
  }

  first<A, R>(extension: Extension<'first', A, R>, args: A): R | undefined {
    for (const handler of this.#snapshot(extension) as Array<HandlerFor<A, R>['first']>) {
      const result = handler(args);
      if (isThenable(result)) throw new Error(`${extension.name} 是首个决定模式，只允许同步监听者`);
      if (result !== undefined && result !== null) return result;
    }
    return undefined;
  }

  #point(extension: Extension<DispatchMode, never, unknown>) {
    let point = this.#points.get(extension.name);
    if (!point) {
      point = { mode: extension.mode, handlers: [] };
      this.#points.set(extension.name, point);
    }
    if (point.mode !== extension.mode) {
      throw new Error(
        `扩展点 ${extension.name} 已声明为 ${point.mode}，不能按 ${extension.mode} 使用`,
      );
    }
    return point;
  }

  /** 分发开始时固定监听者列表，分发过程中的注册与撤销不影响本次分发。 */
  #snapshot(extension: Extension<DispatchMode, never, unknown>): AnyHandler[] {
    return [...this.#point(extension).handlers];
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}
