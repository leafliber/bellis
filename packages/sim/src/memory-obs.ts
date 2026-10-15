import type { EmergencyOutcome, EmergencyPolicy } from '@bellis/obs';
import type { EmergencyObs } from '@bellis/safety';

/** 进程内的模拟 OBS 应急通道：确定性仿真里不走网络，状态可直接查看。 */
export class MemoryObs implements EmergencyObs {
  ready = true;
  currentScene = 'Live';
  readonly muted = new Set<string>();
  readonly runs: EmergencyPolicy[] = [];

  async run(policy: EmergencyPolicy): Promise<EmergencyOutcome> {
    this.runs.push(policy);
    if (!this.ready) throw new Error('模拟 OBS 不可用');
    this.muted.add(policy.stageSource);
    this.currentScene = policy.safeScene;
    return { ok: true, results: [] };
  }
}
