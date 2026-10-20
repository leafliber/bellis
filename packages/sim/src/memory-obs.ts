import type { EmergencyOutcome, EmergencyPolicy } from '@bellis/obs';
import type { EmergencyObs, ObsChange, ObsObserved, ObsWatcher } from '@bellis/safety';

/**
 * 进程内的模拟 OBS 应急通道：确定性仿真里不走网络，状态可直接查看。节目场景与静音真的变了时同步通知订阅者，
 * 与真实 OBS 的事件一样；`external` 模拟在 OBS 里按热键或手动操作。
 */
export class MemoryObs implements EmergencyObs {
  ready = true;
  currentScene = 'Live';
  readonly muted = new Set<string>();
  readonly runs: EmergencyPolicy[] = [];
  readonly #watchers = new Set<ObsWatcher>();

  async run(policy: EmergencyPolicy): Promise<EmergencyOutcome> {
    this.runs.push(policy);
    if (!this.ready) throw new Error('模拟 OBS 不可用');
    this.#apply({ kind: 'mute', inputName: policy.stageSource, muted: true });
    this.#apply({ kind: 'scene', sceneName: policy.safeScene });
    return { ok: true, results: [] };
  }

  watch(watcher: ObsWatcher): () => void {
    this.#watchers.add(watcher);
    return () => this.#watchers.delete(watcher);
  }

  async observe(policy: EmergencyPolicy): Promise<ObsObserved> {
    if (!this.ready) throw new Error('模拟 OBS 不可用');
    return { sceneName: this.currentScene, stageMuted: this.muted.has(policy.stageSource) };
  }

  /** 不经 Bellis 改变 OBS（热键、手动操作）：状态变了就通知订阅者。 */
  external(change: ObsChange): void {
    this.#apply(change);
  }

  #apply(change: ObsChange): void {
    if (change.kind === 'scene') {
      if (this.currentScene === change.sceneName) return;
      this.currentScene = change.sceneName;
    } else {
      if (this.muted.has(change.inputName) === change.muted) return;
      if (change.muted) this.muted.add(change.inputName);
      else this.muted.delete(change.inputName);
    }
    for (const watcher of [...this.#watchers]) watcher.change(change);
  }
}
