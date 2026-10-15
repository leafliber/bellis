import { SessionInfo } from '@bellis/protocol';
import { AsyncEntry, findCredentialsAsync } from '@napi-rs/keyring';
import { Compile } from 'typebox/compile';

/**
 * 统一的凭据存储接口（D-28）。
 * Windows 存凭据管理器、macOS 存 Keychain（R-16）；大块数据的 DPAPI 加密文件在出现超出凭据管理器上限的条目时再加入。
 * 只防其他用户，不防同一用户下的其他程序，与威胁模型一致（D-12）。
 */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** 返回是否确实删除了一项。 */
  delete(name: string): Promise<boolean>;
  /** 已存条目的名字，按字典序；不返回任何值。 */
  names(): Promise<string[]>;
}

const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function checkName(name: string): string {
  if (!SECRET_NAME.test(name)) throw new Error(`凭据名不合法：${name}`);
  return name;
}

/** 系统凭据库：Windows 凭据管理器 / macOS Keychain / Linux Secret Service 或内核密钥环。 */
export class KeyringSecretStore implements SecretStore {
  readonly service: string;

  constructor(service = 'bellis') {
    this.service = service;
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.#entry(name).getPassword()) ?? undefined;
  }

  async set(name: string, value: string): Promise<void> {
    await this.#entry(name).setPassword(value);
  }

  async delete(name: string): Promise<boolean> {
    return this.#entry(name).deleteCredential();
  }

  /**
   * Windows 与 macOS 支持。Linux 上只有 Secret Service 支持列出；没有它时（如 CI）读写回落到内核密钥环，
   * 列出则明确报不支持。
   */
  async names(): Promise<string[]> {
    // 查询结果里带着值，这里只取名字，值不离开本函数。
    let found: Awaited<ReturnType<typeof findCredentialsAsync>>;
    try {
      found = await findCredentialsAsync(this.service);
    } catch (error) {
      throw new Error('当前系统凭据库不支持列出条目', { cause: error });
    }
    return found
      .map((credential) => credential.account)
      .filter((name) => SECRET_NAME.test(name))
      .sort();
  }

  #entry(name: string): AsyncEntry {
    return new AsyncEntry(this.service, checkName(name));
  }
}

/** 进程内存储，只用于测试与 `sim` profile。 */
export class MemorySecretStore implements SecretStore {
  readonly #values = new Map<string, string>();

  async get(name: string): Promise<string | undefined> {
    return this.#values.get(checkName(name));
  }

  async set(name: string, value: string): Promise<void> {
    this.#values.set(checkName(name), value);
  }

  async delete(name: string): Promise<boolean> {
    return this.#values.delete(checkName(name));
  }

  async names(): Promise<string[]> {
    return [...this.#values.keys()].sort();
  }
}

/** 本次会话连接信息在 SecretStore 中的名字（R-23）。 */
export const SESSION_SECRET = 'session';

const isSessionInfo = Compile(SessionInfo);

export async function writeSessionInfo(store: SecretStore, info: SessionInfo): Promise<void> {
  if (!isSessionInfo.Check(info)) throw new Error('会话信息不合法');
  await store.set(SESSION_SECRET, JSON.stringify(info));
}

/** 读取本次会话的连接信息；不存在时返回 undefined，内容不合法时抛错。 */
export async function readSessionInfo(store: SecretStore): Promise<SessionInfo | undefined> {
  const text = await store.get(SESSION_SECRET);
  if (text === undefined) return undefined;
  const value: unknown = JSON.parse(text);
  if (!isSessionInfo.Check(value)) throw new Error('SecretStore 中的会话信息不合法');
  return value;
}
