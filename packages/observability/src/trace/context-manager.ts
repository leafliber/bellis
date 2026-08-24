import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceContext } from "@bellis/contracts";

/**
 * 可选的异步 Trace 上下文管理（docs/phase-1-reference.md）。
 *
 * - 以实例形式创建：每个 `createTraceContextManager()` 拥有独立的
 *   AsyncLocalStorage，不存在模块级共享可变单例，实例之间互不可见。
 * - `current()` 无上下文时返回 `null`，不会静默复用上一次请求的上下文。
 * - Worker/WS/Outbox 等跨线程、跨进程边界必须显式序列化 TraceContext
 *   （写入 Envelope/Record/Outbox），本管理器只在单线程异步链内生效。
 */

export interface TraceContextManager {
  /** 在指定上下文中执行回调；回调内的 `current()` 返回该上下文。 */
  run<R>(context: TraceContext, callback: () => R): R;
  /** 当前异步上下文的 TraceContext；无上下文时返回 null。 */
  current(): TraceContext | null;
  /** 显式绑定：返回在指定上下文中执行的函数包装（用于回调和事件处理器）。 */
  bind<F extends (...args: never[]) => unknown>(context: TraceContext, callback: F): F;
}

export function createTraceContextManager(): TraceContextManager {
  const storage = new AsyncLocalStorage<TraceContext>();
  const bind = <F extends (...args: never[]) => unknown>(context: TraceContext, callback: F): F => {
    return ((...args: never[]) => storage.run(context, () => callback(...args))) as F;
  };
  return {
    run: (context, callback) => storage.run(context, callback),
    current: () => storage.getStore() ?? null,
    bind,
  };
}
