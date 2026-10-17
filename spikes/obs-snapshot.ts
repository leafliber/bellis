/**
 * 真机演练前后的 OBS 盘点（只读）与恢复：节目场景、场景与输入的名字、安全场景的场景项、
 * Stage 源的静音状态与全部设置。演练只做可逆改动，结束时整体写回并再盘点一次，比对是否恢复原样。
 * URL 里有一次性令牌，差异只报是否相同，不写出内容。
 */
import { isDeepStrictEqual } from 'node:util';
import type { ObsClient, ObsResult } from '@bellis/obs';

export interface ObsSnapshot {
  programScene: string;
  scenes: string[];
  inputs: string[];
  safeItems: Array<{ sourceName: string; sceneItemId: number; enabled: boolean }>;
  stageMuted: boolean | null;
  stageSettings: Record<string, unknown>;
}

function ok(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

export async function snapshot(
  obs: ObsClient,
  stageSource: string,
  safeScene: string,
): Promise<ObsSnapshot> {
  const scenes = ok(await obs.request('GetSceneList'));
  const inputs = ok(await obs.request('GetInputList'));
  const safe = await obs.request('GetSceneItemList', { sceneName: safeScene });
  const settings = await obs.request('GetInputSettings', { inputName: stageSource });
  const mute = await obs.request('GetInputMute', { inputName: stageSource });
  return {
    programScene: scenes.currentProgramSceneName as string,
    scenes: (scenes.scenes as Array<{ sceneName: string }>).map((s) => s.sceneName),
    inputs: (inputs.inputs as Array<{ inputName: string }>).map((i) => i.inputName).sort(),
    safeItems:
      (
        (safe.ok ? safe.data?.sceneItems : undefined) as
          | Array<{ sourceName: string; sceneItemId: number; sceneItemEnabled: boolean }>
          | undefined
      )?.map((i) => ({
        sourceName: i.sourceName,
        sceneItemId: i.sceneItemId,
        enabled: i.sceneItemEnabled,
      })) ?? [],
    stageMuted: mute.ok ? (mute.data?.inputMuted as boolean) : null,
    stageSettings: settings.ok
      ? ((settings.data?.inputSettings ?? {}) as Record<string, unknown>)
      : {},
  };
}

/** 两次盘点的差异；URL 只报是否相同。 */
export function differences(before: ObsSnapshot, after: ObsSnapshot): string[] {
  const diffs: string[] = [];
  for (const key of ['programScene', 'scenes', 'inputs', 'safeItems', 'stageMuted'] as const) {
    if (!isDeepStrictEqual(before[key], after[key]))
      diffs.push(`${key}：${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);
  }
  const { url: urlBefore, ...restBefore } = before.stageSettings;
  const { url: urlAfter, ...restAfter } = after.stageSettings;
  if (urlBefore !== urlAfter) diffs.push('浏览器源 URL 与开始时不同');
  if (!isDeepStrictEqual(restBefore, restAfter))
    diffs.push(`浏览器源设置：${JSON.stringify(restBefore)} → ${JSON.stringify(restAfter)}`);
  return diffs;
}

/**
 * 把 Stage 源的设置（含 URL）、节目场景与静音写回盘点时的样子，返回失败的步骤。
 * 设置用 overlay=false 整体写回：先恢复缺省，再写入原来的设置。
 */
export async function restoreSnapshot(
  obs: ObsClient,
  original: ObsSnapshot,
  stageSource: string,
): Promise<string[]> {
  const failed: string[] = [];
  const attempt = async (label: string, request: () => Promise<ObsResult>) => {
    try {
      const answer = await request();
      if (!answer.ok) failed.push(`${label}失败：${answer.code} ${answer.comment ?? ''}`);
    } catch (error) {
      failed.push(`${label}出错：${(error as Error).message}`);
    }
  };
  await attempt('写回浏览器源设置', () =>
    obs.request('SetInputSettings', {
      inputName: stageSource,
      inputSettings: original.stageSettings,
      overlay: false,
    }),
  );
  await attempt('切回原场景', () =>
    obs.request('SetCurrentProgramScene', { sceneName: original.programScene }),
  );
  await attempt('恢复静音状态', () =>
    obs.request('SetInputMute', {
      inputName: stageSource,
      inputMuted: original.stageMuted ?? false,
    }),
  );
  return failed;
}
