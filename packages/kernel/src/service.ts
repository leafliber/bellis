/**
 * 服务：占据一个稳定名字的能力，按 `名字@主版本` 匹配。同一个名字同一时刻只有一个提供方。
 */

/** 带类型的服务标识。插件清单里用 `ref` 声明，代码里用标识取得服务。 */
export interface ServiceToken<T> {
  readonly name: string;
  readonly major: number;
  readonly ref: string;
  /** 只用于类型推断。 */
  readonly _type?: T;
}

export function defineService<T>(name: string, major: number): ServiceToken<T> {
  return { name, major, ref: `${name}@${major}` };
}

export interface ParsedRef {
  name: string;
  major: number;
  optional: boolean;
}

const REF = /^([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)@([0-9]+)(\?)?$/;

export function parseRef(ref: string): ParsedRef {
  const match = REF.exec(ref);
  if (!match) throw new Error(`服务引用不合法：${ref}`);
  return { name: match[1] as string, major: Number(match[2]), optional: match[3] === '?' };
}

interface Provision {
  major: number;
  impl: unknown;
  provider: string;
  /** 为 true 时 impl 是按插件实例生成实现的工厂。 */
  scoped: boolean;
}

export interface ServiceInfo {
  name: string;
  major: number;
  provider: string;
}

export class ServiceRegistry {
  readonly #services = new Map<string, Provision>();

  /** 注册服务，返回撤销函数。名字已被占用时抛错。 */
  add(name: string, major: number, impl: unknown, provider: string, scoped = false): () => void {
    const existing = this.#services.get(name);
    if (existing) {
      throw new Error(`服务 ${name} 已由 ${existing.provider} 提供`);
    }
    const provision: Provision = { major, impl, provider, scoped };
    this.#services.set(name, provision);
    return () => {
      if (this.#services.get(name) === provision) this.#services.delete(name);
    };
  }

  /** 按名字与主版本查找；不存在或主版本不同时返回原因。 */
  resolve(name: string, major: number): { impl: unknown; scoped: boolean } | { missing: string } {
    const provision = this.#services.get(name);
    if (!provision) return { missing: `缺少服务 ${name}@${major}` };
    if (provision.major !== major) {
      return { missing: `服务 ${name} 版本不兼容：需要 @${major}，现有 @${provision.major}` };
    }
    return { impl: provision.impl, scoped: provision.scoped };
  }

  providedBy(provider: string): string[] {
    return [...this.#services].filter(([, p]) => p.provider === provider).map(([name]) => name);
  }

  list(): ServiceInfo[] {
    return [...this.#services].map(([name, p]) => ({ name, major: p.major, provider: p.provider }));
  }
}
