import type { Intent, IntentInput, StateStore } from './store.ts';

/**
 * 执行一次副作用：写入意图 → 标为执行中 → 执行 → 写入结果（见状态存储的副作用流程）。
 * 幂等键已存在时不执行，直接返回已有意图。执行中崩溃的意图在重启后由 `recover` 标为 `unknown`。
 */
export async function executeOnce(
  store: StateStore,
  input: IntentInput,
  effect: (intent: Intent) => Promise<unknown>,
): Promise<{ intent: Intent; executed: boolean }> {
  const { intent, duplicate } = store.authorize(input);
  if (duplicate) return { intent, executed: false };
  store.start(intent.id);
  store.checkpoint('effect:before');
  let result: unknown;
  try {
    result = await effect(intent);
  } catch (error) {
    return {
      intent: store.fail(intent.id, error instanceof Error ? error.message : String(error)),
      executed: true,
    };
  }
  store.checkpoint('effect:after');
  return { intent: store.succeed(intent.id, result), executed: true };
}
