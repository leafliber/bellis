import { type PluginSecrets, secretPermission } from '@bellis/kernel';
import type { SecretStore } from '@bellis/secret-store';

/**
 * 为一个插件实例生成凭据访问：只放行 profile 授予它的条目（`secret:<名字>`）。
 * 宿主自己管理的条目（会话连接信息、OBS 凭据）任何插件都拿不到，授予了也不行。
 */
export function pluginSecrets(
  store: SecretStore,
  permissions: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): PluginSecrets {
  const check = (name: string) => {
    if (reserved.has(name)) throw new Error(`凭据 ${name} 由宿主管理，插件不能访问`);
    if (!permissions.has(secretPermission(name))) {
      throw new Error(`没有权限 ${secretPermission(name)}`);
    }
  };
  return {
    async read(name) {
      check(name);
      return store.get(name);
    },
    async write(name, value) {
      check(name);
      await store.set(name, value);
    },
    async delete(name) {
      check(name);
      return store.delete(name);
    },
  };
}
