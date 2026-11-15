import type { GamePacing } from '@bellis/game-bridge';
import type { Clock } from '@bellis/kernel';

/** 既能按宿主时钟到期，也能被一次发言的停止或游戏会话失效撤回。 */
export async function waitForPacing<T>(
  work: Promise<T>,
  clock: Clock,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted || timeoutMs <= 0) return undefined;
  const done = Promise.withResolvers<undefined>();
  const stop = () => done.resolve(undefined);
  const timer = clock.setTimeout(stop, timeoutMs);
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([work, done.promise]);
  } finally {
    clock.clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

export async function waitForVoice(
  game: GamePacing,
  clock: Clock,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = clock.now() + timeoutMs;
  while (!signal.aborted && game.voiceActivity() === 'busy') {
    const changed = Promise.withResolvers<true>();
    const unsubscribe = game.subscribeVoice(() => {
      if (game.voiceActivity() !== 'busy') changed.resolve(true);
    });
    try {
      if (!(await waitForPacing(changed.promise, clock, deadline - clock.now(), signal))) break;
    } finally {
      unsubscribe();
    }
  }
  // 在通知或截止后重读，过时的忙状态按未知处理。
  return game.voiceActivity() !== 'busy';
}
