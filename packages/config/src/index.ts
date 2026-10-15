import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { HostConfig, ObsSecret } from '@bellis/protocol';
import type { SecretStore } from '@bellis/secret-store';
import { Compile } from 'typebox/compile';

const isHostConfig = Compile(HostConfig);
const isObsSecret = Compile(ObsSecret);

/** OBS 凭据在 SecretStore 中的名字。 */
export const OBS_SECRET = 'obs';

function describe(check: ReturnType<typeof Compile>, value: unknown): string {
  const first = [...check.Errors(value)][0];
  return first ? `${first.instancePath || '/'} ${first.message}` : '';
}

/** 读取并校验配置文件；相对的存储路径以配置文件所在目录为基准。 */
export function loadConfig(path: string): HostConfig {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isHostConfig.Check(value))
    throw new Error(`配置文件 ${path} 不合法：${describe(isHostConfig, value)}`);
  return { ...value, storePath: resolve(dirname(path), value.storePath) };
}

export async function readObsSecret(store: SecretStore): Promise<ObsSecret> {
  const text = await store.get(OBS_SECRET);
  if (text === undefined) throw new Error('SecretStore 中没有 OBS 凭据');
  const value: unknown = JSON.parse(text);
  if (!isObsSecret.Check(value)) throw new Error(`OBS 凭据不合法：${describe(isObsSecret, value)}`);
  return value;
}

export async function writeObsSecret(store: SecretStore, secret: ObsSecret): Promise<void> {
  if (!isObsSecret.Check(secret))
    throw new Error(`OBS 凭据不合法：${describe(isObsSecret, secret)}`);
  await store.set(OBS_SECRET, JSON.stringify(secret));
}
