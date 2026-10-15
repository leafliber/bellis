import type { PluginManifest } from '@bellis/protocol';
import type { Static, TSchema } from 'typebox';
import type { DispatchMode, Extension, Handler } from './extension.ts';
import type { ServiceToken } from './service.ts';

export type Disposer = () => void | Promise<void>;

/** 进程内插件的清单：与协议中的清单相同，但配置 Schema 用 TypeBox 定义。 */
export type Manifest<C extends TSchema = TSchema> = Omit<PluginManifest, 'config'> & { config: C };

export interface PluginDefinition<C extends TSchema = TSchema> {
  readonly manifest: Manifest<C>;
  /**
   * 激活：取得依赖、提供服务、注册副作用。所有副作用都经 ctx 注册，以便撤销。
   * 抛错即加载失败，已注册的副作用会被撤销。服务在激活成功后才对其他插件可见。
   */
  activate(ctx: PluginContext<Static<C>>): void | Promise<void>;
  /**
   * 静止中：停止新工作、取消在途任务、等待物理确认（例如已静音、输入已释放）。
   * 超过截止时间未完成时，内核把 `ctx.forced` 置为 true 后强制运行撤销函数。
   */
  quiesce?(ctx: PluginContext<Static<C>>): void | Promise<void>;
}

export function definePlugin<C extends TSchema>(
  definition: PluginDefinition<C>,
): PluginDefinition<C> {
  return definition;
}

/** 插件拿到的收窄上下文：只能看到自己声明的依赖。 */
export interface PluginContext<Config = unknown> {
  readonly entryId: string;
  readonly instanceId: string;
  readonly config: Config;
  /** profile 授予的权限。 */
  readonly permissions: ReadonlySet<string>;
  /** 进入静止中时中止：停止接收新工作。 */
  readonly signal: AbortSignal;
  /** 收尾超时后为 true：撤销函数应直接强制清理（例如终止子进程）。 */
  readonly forced: boolean;
  /** 取得必需依赖。 */
  service<T>(token: ServiceToken<T>): T;
  /** 探测可选依赖（inject 中以 `?` 结尾）；不存在时返回 undefined。 */
  optional<T>(token: ServiceToken<T>): T | undefined;
  /** 提供清单中声明的服务；只能在激活期间调用。 */
  provide<T>(token: ServiceToken<T>, impl: T): void;
  /** 在扩展点上注册监听者，卸载时自动撤销。 */
  on<E extends Extension<DispatchMode, never, unknown>>(extension: E, handler: Handler<E>): void;
  /** 注册撤销函数；卸载时按后注册先撤销的顺序运行。 */
  register(disposer: Disposer): void;
  /** 运行中无法继续：内核把实例卸载为 FAILED，并按退避重试。 */
  fail(error: Error): void;
  log(event: string, fields?: Record<string, unknown>): void;
}

export type PluginCatalog = ReadonlyMap<string, PluginDefinition>;

export function catalog(...definitions: PluginDefinition[]): PluginCatalog {
  const map = new Map<string, PluginDefinition>();
  for (const definition of definitions) {
    if (map.has(definition.manifest.id)) throw new Error(`插件 ${definition.manifest.id} 重复`);
    map.set(definition.manifest.id, definition);
  }
  return map;
}
