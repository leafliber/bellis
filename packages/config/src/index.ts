import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { HostConfig, ObsSecret } from '@bellis/protocol';
import type { SecretStore } from '@bellis/secret-store';
import { Compile } from 'typebox/compile';

const isHostConfig = Compile(HostConfig);
const isObsSecret = Compile(ObsSecret);

/** 真实 OBS 的凭据在 SecretStore 中的名字，由维护者用 `pnpm secret set obs` 录入。 */
export const OBS_SECRET = 'obs';
/** 模拟 OBS 的凭据名，由 sim 启动器写入与删除；与真实凭据分开，跑仿真不会覆盖或删掉真实凭据。 */
export const SIM_OBS_SECRET = 'obs-sim';

/** 宿主与看门狗按配置决定读哪一份 OBS 凭据。 */
export function obsSecretName(config: Pick<HostConfig, 'simulation'>): string {
  return config.simulation ? SIM_OBS_SECRET : OBS_SECRET;
}

function describe(check: ReturnType<typeof Compile>, value: unknown): string {
  const first = [...check.Errors(value)][0];
  return first ? `${first.instancePath || '/'} ${first.message}` : '';
}

/** 读取并校验配置文件；相对的存储路径以配置文件所在目录为基准。 */
export function loadConfig(path: string): HostConfig {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isHostConfig.Check(value))
    throw new Error(`配置文件 ${path} 不合法：${describe(isHostConfig, value)}`);
  const base = dirname(path);
  return {
    ...value,
    storePath: resolve(base, value.storePath),
    profile: resolve(base, value.profile),
    patches: value.patches.map((patch) => resolve(base, patch)),
  };
}

export async function readObsSecret(store: SecretStore, name: string): Promise<ObsSecret> {
  const text = await store.get(name);
  if (text === undefined) throw new Error(`SecretStore 中没有 OBS 凭据（${name}）`);
  const value: unknown = JSON.parse(text);
  if (!isObsSecret.Check(value)) throw new Error(`OBS 凭据不合法：${describe(isObsSecret, value)}`);
  return value;
}

export async function writeObsSecret(
  store: SecretStore,
  secret: ObsSecret,
  name: string,
): Promise<void> {
  if (!isObsSecret.Check(secret))
    throw new Error(`OBS 凭据不合法：${describe(isObsSecret, secret)}`);
  await store.set(name, JSON.stringify(secret));
}
