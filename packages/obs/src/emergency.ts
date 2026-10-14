import type { ObsClient } from './client.ts';
import { type ObsRequest, type ObsResult, RequestStatus } from './protocol.ts';

/** 应急动作的目标，固定在配置中，开播预检确认它们存在。 */
export interface EmergencyPolicy {
  /** Stage 浏览器源的名字。 */
  stageSource: string;
  safeScene: string;
  /** 是否同时停止推流。 */
  stopStream: boolean;
}

export function emergencyRequests(policy: EmergencyPolicy): ObsRequest[] {
  return [
    {
      requestType: 'SetInputMute',
      requestData: { inputName: policy.stageSource, inputMuted: true },
    },
    { requestType: 'SetCurrentProgramScene', requestData: { sceneName: policy.safeScene } },
    ...(policy.stopStream ? [{ requestType: 'StopStream' }] : []),
  ];
}

export interface EmergencyOutcome {
  ok: boolean;
  results: ObsResult[];
}

/**
 * 用一次 RequestBatch 静音 Stage 源、切到安全场景，按策略停止推流（R-14、D-30）。
 * 推流本来就没在运行时，停止推流视为成功。
 */
export async function runEmergency(
  client: ObsClient,
  policy: EmergencyPolicy,
  timeoutMs = 1000,
): Promise<EmergencyOutcome> {
  const requests = emergencyRequests(policy);
  const results = await client.batch(requests, { timeoutMs });
  // 每个请求都要有对应的成功结果；结果缺失或对不上一律算失败。
  const ok =
    results.length === requests.length &&
    requests.every((request, index) => {
      const result = results[index];
      if (!result || result.requestType !== request.requestType) return false;
      return (
        result.ok ||
        (result.requestType === 'StopStream' && result.code === RequestStatus.OutputNotRunning)
      );
    });
  return { ok, results };
}
