import { payloadHash } from './payload.ts';
import type { Intent, IntentInput, StateStore } from './store.ts';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 执行一个已授权的意图：先核对载荷与授权时的摘要一致，再标为执行中 → 执行 → 写入结果。
 * 副作用只拿到核对过的载荷。执行中崩溃的意图在重启后由 `recover` 标为 `unknown`。
 */
export async function executeIntent<P>(
  store: StateStore,
  intent: Intent,
  payload: P,
  effect: (payload: P, intent: Intent) => Promise<unknown>,
): Promise<Intent> {
  if (payloadHash(payload) !== intent.payloadHash) {
    throw new Error(`意图 ${intent.key} 的载荷与授权时不一致`);
  }
  store.start(intent.id);
  store.checkpoint('effect:before');
  let result: unknown;
  try {
    result = await effect(payload, intent);
  } catch (error) {
    return store.fail(intent.id, message(error));
  }
  store.checkpoint('effect:after');
  return store.succeed(intent.id, result);
}

/** 写入意图并执行一次；幂等键已存在时不执行，直接返回已有意图。 */
export async function executeOnce<P>(
  store: StateStore,
  input: Omit<IntentInput, 'payloadHash'>,
  payload: P,
  effect: (payload: P, intent: Intent) => Promise<unknown>,
): Promise<{ intent: Intent; executed: boolean }> {
  const { intent, duplicate } = store.authorize({ ...input, payloadHash: payloadHash(payload) });
  if (duplicate) return { intent, executed: false };
  return { intent: await executeIntent(store, intent, payload, effect), executed: true };
}
