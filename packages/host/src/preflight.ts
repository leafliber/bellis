import type { EntrySnapshot } from '@bellis/kernel';

/** 开播预检的输入：宿主从插件内核、Stage 服务、安全核与 OBS 应急连接收集。 */
export interface PreflightInputs {
  target: 'M1' | 'M2' | 'M3';
  /** profile 中的全部条目。 */
  plugins: readonly EntrySnapshot[];
  /** Stage 服务是否在场、页面是否已认证；没有 Stage 服务时为 undefined。 */
  stageReady: boolean | undefined;
  /**
   * 形象是否就绪（已连上 VTube Studio 并认证、嘴型参数可写）与状态说明；profile 不含形象时为 undefined，
   * 不作要求（profile 中启用了形象却没激活，由插件状态一项报告）。
   */
  avatar: { ready: boolean; status: string } | undefined;
  /** 审核插件的开关；未显式设置时为 undefined。 */
  moderationEnabled: boolean | undefined;
  /** M1 的逐句放行环节是否在场。 */
  reviewPresent: boolean;
  /**
   * TTS 路由配置中第一个音频引擎（只出字幕不算）的状态；没有 TTS 路由或没有配置音频引擎时为 undefined，
   * 不核对（只用模拟 TTS 的 profile）。
   */
  ttsPrimary: { engine: string; ready: boolean; status: string } | undefined;
  /** OBS 应急目标的只读核对，返回未通过的项。 */
  inspectObs(): Promise<string[]>;
}

/**
 * 开播预检中与 P1 相关的项（见运维“开播预检”）。返回未通过的项，全部通过时为空；任一未通过都不允许进入
 * 真实输出模式。监督模式本身的前置条件（状态存储、OBS 应急连接、看门狗、在场确认）由安全核在切换时核对。
 */
export async function preflight(inputs: PreflightInputs): Promise<string[]> {
  const failures: string[] = [];
  for (const entry of inputs.plugins) {
    if (!entry.enabled || entry.state === 'active') continue;
    failures.push(
      `插件 ${entry.id} 未就绪（${entry.state}${entry.reason ? `：${entry.reason}` : ''}）`,
    );
  }
  if (inputs.stageReady === undefined) failures.push('Stage 服务不在场');
  else if (!inputs.stageReady) failures.push('Stage 页面尚未认证');
  if (inputs.avatar && !inputs.avatar.ready) failures.push(`形象未就绪（${inputs.avatar.status}）`);
  if (inputs.moderationEnabled === undefined)
    failures.push('审核插件的开关没有在 profile 中显式设置');
  if (inputs.ttsPrimary && !inputs.ttsPrimary.ready)
    failures.push(`TTS 主引擎 ${inputs.ttsPrimary.engine} 未就绪：${inputs.ttsPrimary.status}`);
  if (inputs.target === 'M1' && !inputs.reviewPresent)
    failures.push('M1 需要逐句放行环节（speech-review）');
  try {
    failures.push(...(await inputs.inspectObs()));
  } catch (error) {
    failures.push(`OBS 预检失败：${(error as Error).message}`);
  }
  return failures;
}
