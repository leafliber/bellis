import type { ObsClient } from './client.ts';
import type { EmergencyPolicy } from './emergency.ts';

/**
 * 开播预检中与 OBS 有关的项（只读）：安全场景与 Stage 源存在；Stage 是浏览器源时按 Stage 文档的
 * 要求开启“Control audio via OBS”、不在隐藏时关闭、不在场景激活时刷新；安全场景里不含 Stage 源
 * （安全停止下写 Stage URL 的例外以此为前提）。返回未通过的项，全部通过时为空。
 * obs-websocket 的 GetInputSettings 只返回改过默认值的设置，所以默认关闭的两项缺省即为通过。
 */
export async function inspectObsTargets(
  client: ObsClient,
  policy: EmergencyPolicy,
): Promise<string[]> {
  const failures: string[] = [];
  const scenes = await client.request('GetSceneList');
  const names = ((scenes.data?.scenes ?? []) as Array<{ sceneName: string }>).map(
    (scene) => scene.sceneName,
  );
  if (!names.includes(policy.safeScene)) failures.push(`OBS 中没有安全场景「${policy.safeScene}」`);

  const input = await client.request('GetInputSettings', { inputName: policy.stageSource });
  if (!input.ok) {
    failures.push(`OBS 中没有 Stage 源「${policy.stageSource}」`);
  } else if (input.data?.inputKind === 'browser_source') {
    const settings = (input.data.inputSettings ?? {}) as Record<string, unknown>;
    if (settings.reroute_audio !== true)
      failures.push(`Stage 源「${policy.stageSource}」没有开启“Control audio via OBS”`);
    if (settings.shutdown === true)
      failures.push(`Stage 源「${policy.stageSource}」开启了“Shutdown source when not visible”`);
    if (settings.restart_when_active === true)
      failures.push(
        `Stage 源「${policy.stageSource}」开启了“Refresh browser when scene becomes active”`,
      );
  }

  if (names.includes(policy.safeScene)) {
    const items = await client.request('GetSceneItemList', { sceneName: policy.safeScene });
    const sources = ((items.data?.sceneItems ?? []) as Array<{ sourceName: string }>).map(
      (item) => item.sourceName,
    );
    if (sources.includes(policy.stageSource))
      failures.push(`安全场景「${policy.safeScene}」里含有 Stage 源「${policy.stageSource}」`);
  }
  return failures;
}
