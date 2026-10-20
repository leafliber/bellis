import { dirname, join } from 'node:path';
import { loadConfig } from '@bellis/config';
import { readJsonFile, resolveProfile } from '@bellis/kernel';
import Value from 'typebox/value';
import { TelemetryConfig } from './plugin.ts';

/** 按宿主配置文件找遥测目录：状态存储所在目录，加 profile 里启用的 `telemetry` 条目的 `dir`。 */
export function telemetryDir(configPath: string): string {
  const config = loadConfig(configPath);
  const entries = resolveProfile(readJsonFile(config.profile), config.patches.map(readJsonFile));
  const entry = entries.find((e) => e.plugin === 'telemetry' && !e.disabled);
  if (!entry) throw new Error(`${config.profile} 里没有启用的 telemetry 插件`);
  const settings = Value.Default(TelemetryConfig, structuredClone(entry.config ?? {})) as {
    dir: string;
  };
  return join(dirname(config.storePath), settings.dir);
}
