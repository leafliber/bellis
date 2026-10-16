/**
 * 探针前的 OBS 盘点（只读）：版本、场景、输入、浏览器源的关键设置、推流与录制状态。
 *   node spikes/obs-check.ts
 * 用 SecretStore 中的 obs 凭据连接；不打印凭据，浏览器源的 URL 只显示是否带片段，不显示内容。
 */
import { OBS_SECRET, readObsSecret } from '@bellis/config';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { KeyringSecretStore } from '@bellis/secret-store';

const secret = await readObsSecret(
  new KeyringSecretStore(process.env.BELLIS_SECRET_SERVICE ?? 'bellis'),
  OBS_SECRET,
);
const obs = await ObsClient.connect(secret.url, secret.password);

function data(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

/** 浏览器源里与 Stage 相关的设置（R-09 与 Stage 文档的 OBS 配置要求）。 */
const BROWSER_KEYS = ['reroute_audio', 'shutdown', 'restart_when_active', 'webpage_control_level'];

try {
  const version = data(await obs.request('GetVersion'));
  console.log(
    `OBS ${version.obsVersion}，obs-websocket ${version.obsWebSocketVersion}，平台 ${version.platformDescription}`,
  );
  const video = data(await obs.request('GetVideoSettings'));
  console.log(
    `画布 ${video.baseWidth}x${video.baseHeight}，${video.fpsNumerator}/${video.fpsDenominator} fps`,
  );
  const stream = data(await obs.request('GetStreamStatus'));
  const record = data(await obs.request('GetRecordStatus'));
  console.log(`推流中：${stream.outputActive}；录制中：${record.outputActive}`);
  const scenes = data(await obs.request('GetSceneList'));
  console.log(`当前节目场景：${scenes.currentProgramSceneName}`);
  for (const scene of (scenes.scenes as Array<{ sceneName: string }>).toReversed()) {
    const items = data(await obs.request('GetSceneItemList', { sceneName: scene.sceneName }));
    const names = (
      items.sceneItems as Array<{ sourceName: string; sceneItemEnabled: boolean }>
    ).map((item) => `${item.sourceName}${item.sceneItemEnabled ? '' : '（隐藏）'}`);
    console.log(`  场景「${scene.sceneName}」：${names.join('、') || '（空）'}`);
  }
  const inputs = data(await obs.request('GetInputList'));
  for (const input of inputs.inputs as Array<{ inputName: string; inputKind: string }>) {
    const muted = data(
      await obs.request('GetInputMute', { inputName: input.inputName }),
    ).inputMuted;
    let detail = '';
    if (input.inputKind === 'browser_source') {
      const settings = data(await obs.request('GetInputSettings', { inputName: input.inputName }))
        .inputSettings as Record<string, unknown>;
      const picked = BROWSER_KEYS.map((key) => `${key}=${JSON.stringify(settings[key] ?? '缺省')}`);
      const url = typeof settings.url === 'string' ? settings.url : '';
      picked.push(`url=${url ? `${url.split('#')[0]}${url.includes('#') ? '#…' : ''}` : '（空）'}`);
      detail = ` ${picked.join(' ')}`;
    }
    console.log(`  输入「${input.inputName}」${input.inputKind} 静音=${muted}${detail}`);
  }
} finally {
  obs.close();
}
