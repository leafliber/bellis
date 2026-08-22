import { isAbsolute } from "node:path";
import { z } from "zod";
import type { LogLevel } from "@bellis/observability";

/**
 * Runtime 配置 Schema 与校验（P4 文档 §5.2）。
 *
 * 配置输入类型固定为 `unknown`：生产启动（环境变量/CLI）与测试注入都
 * 先经过这里的单一校验入口，未校验配置不得进入装配。
 *
 * 安全基线：
 * - Host 默认且只允许 loopback 字面量；开放 LAN 需要独立安全决策。
 * - 数据目录必须显式传入绝对路径，没有仓库内默认值。
 * - Token、Cookie、密钥不配置在日志可见字段中，也不进入 Version/OpenAPI。
 */

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

/** 只允许 loopback 监听地址（phase-1-build-guide.md §8.1）。 */
const BindHostSchema = z.enum(["127.0.0.1", "localhost", "::1"]);

/** 允许的 Host 头（主机名，不带端口；端口在比较时剥离）。 */
const AllowedHostSchema = z.enum(LOOPBACK_HOSTS);

const OriginSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return false;
      }
      const host = url.hostname.toLowerCase();
      return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    } catch {
      return false;
    }
  }, "origin must be a loopback http(s) URL");

const PositiveInt = (max: number) => z.number().int().positive().max(max);

const RuntimeConfigSchema = z
  .object({
    host: BindHostSchema.default("127.0.0.1"),
    /** 正式默认 17890；测试可注入随机空闲端口（0 = 由 OS 分配 loopback 临时端口）。 */
    port: z.number().int().min(0).max(65_535).default(17_890),
    allowedHosts: z.array(AllowedHostSchema).min(1).default(["127.0.0.1", "localhost"]),
    /**
     * 显式 Origin 允许列表；缺省时按 allowedHosts + 实际监听端口推导
     * （http://<host>:<port>）。显式条目必须是 loopback http(s) URL。
     */
    allowedOrigins: z.array(OriginSchema).min(1).optional(),
    /** 允许缺失 Origin 的非浏览器客户端；默认拒绝（P4 文档 §8）。 */
    allowMissingOrigin: z.boolean().default(false),
    /** 数据目录绝对路径；必填，无默认值。 */
    dataDirectory: z
      .string()
      .min(1)
      .refine((value) => isAbsolute(value), "dataDirectory must be an absolute path"),
    runtimeVersion: z.string().min(1).max(64),
    buildInfo: z
      .object({
        commit: z.string().min(1).max(64).optional(),
        builtAtMs: z.number().int().nonnegative().optional(),
      })
      .default({}),
    startupTokenTtlMs: PositiveInt(3_600_000).default(60_000),
    sessionCookieName: z.string().min(1).max(64).default("bellis_session"),
    logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
    shutdownGraceMs: PositiveInt(120_000).default(10_000),
    limits: z
      .object({
        heartbeatIntervalMs: PositiveInt(600_000).default(30_000),
        helloTimeoutMs: PositiveInt(600_000).default(10_000),
        replayWindowCapacity: PositiveInt(100_000).default(512),
        dedupCapacity: PositiveInt(1_000_000).default(1024),
        maxControlTextBytes: PositiveInt(16 * 1024 * 1024).default(1_048_576),
        /** 等待单条服务端消息实际写出 Socket 的上限；超时降级关闭连接。 */
        sendFlushTimeoutMs: PositiveInt(120_000).default(5_000),
        sendQueue: z
          .object({
            maxMessages: PositiveInt(1_000_000).default(512),
            maxBytes: PositiveInt(64 * 1024 * 1024).default(8 * 1024 * 1024),
          })
          .prefault({}),
        maxMediaHeaderBytes: PositiveInt(1024 * 1024).default(16 * 1024),
        maxMediaPayloadBytes: PositiveInt(64 * 1024 * 1024).default(1024 * 1024),
        maxOpenStreams: PositiveInt(1024).default(8),
        maxTotalStreams: PositiveInt(1_000_000).default(1024),
        maxFramesPerStream: PositiveInt(10_000_000).default(65_536),
        /** 逻辑 Session 自创建起的存活时长；过期后 Cookie 解析失败。 */
        sessionTtlMs: PositiveInt(86_400_000).default(3_600_000),
        /** 逻辑 Session 容量上限；超出按创建时间淘汰最旧（含强关其连接）。 */
        maxSessions: PositiveInt(100_000).default(1024),
      })
      .prefault({}),
    outbox: z
      .object({
        pollIntervalMs: PositiveInt(60_000).default(100),
        leaseMs: PositiveInt(600_000).default(5_000),
        claimLimit: PositiveInt(256).default(32),
        stopGraceMs: PositiveInt(120_000).default(5_000),
      })
      .prefault({}),
    persistence: z
      .object({
        defaultDeadlineMs: PositiveInt(120_000).default(10_000),
      })
      .prefault({}),
  })
  .superRefine((config, ctx) => {
    // 跨字段约束：P1 ControlSession 构造要求 Replay Window 容量不超过
    // 发送队列消息上限（否则 Upgrade 时构造失败）。无效组合必须在启动
    // 前稳定失败，不允许进入装配。
    if (config.limits.replayWindowCapacity > config.limits.sendQueue.maxMessages) {
      ctx.addIssue({
        code: "custom",
        path: ["limits", "replayWindowCapacity"],
        message: `replayWindowCapacity (${config.limits.replayWindowCapacity}) must not exceed sendQueue.maxMessages (${config.limits.sendQueue.maxMessages})`,
      });
    }
  });

export type RuntimeConfigInput = z.input<typeof RuntimeConfigSchema>;

/** 校验后的 Runtime 配置（含全部默认值已展开的输出类型）。 */
export type RuntimeConfig = z.output<typeof RuntimeConfigSchema>;

export interface RuntimeConfigIssue {
  readonly path: string;
  readonly message: string;
}

export type ParseConfigResult =
  | { readonly ok: true; readonly config: RuntimeConfig }
  | { readonly ok: false; readonly issues: readonly RuntimeConfigIssue[] };

/**
 * 校验配置输入。返回结果对象而不是抛异常：调用方（CLI / 装配 / 测试）
 * 需要在启动失败时输出安全的逐字段错误，不携带环境值本身。
 */
export function parseRuntimeConfig(input: unknown): ParseConfigResult {
  const parsed = RuntimeConfigSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
      message: issue.message,
    })),
  };
}

/** 合法端口：非空纯数字、值域 1..65535（Host 头里没有 0 端口）。 */
function isValidPortSuffix(suffix: string): boolean {
  if (!/^:\d{1,5}$/.test(suffix)) {
    return false;
  }
  const port = Number(suffix.slice(1));
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * 解析 Host 头的主机名（剥离端口；IPv6 [::1]:port 形式归一为 ::1）。
 * 返回 null 表示无法解析的欺骗值，一律拒绝：
 * - 方括号形式只允许 `[host]` 或 `[host]:port`（port 为纯数字且
 *   1..65535），`[::1]evil` / `[::1]:65536` / `[::1]:99999` 返回 null；
 * - 非 bracket、单冒号形式的端口必须非空纯数字且 1..65535，
 *   `localhost:evil` / `127.0.0.1:` 返回 null；
 * - 多冒号裸 IPv6 字面量整体作为主机名（不在允许列表内即被拒）。
 */
export function normalizeHostHeader(hostHeader: string): string | null {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 255) {
    return null;
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0) {
      return null;
    }
    // ']' 之后只允许为空或 ":<合法端口>"。
    const suffix = trimmed.slice(end + 1);
    if (suffix !== "" && !isValidPortSuffix(suffix)) {
      return null;
    }
    return trimmed.slice(1, end);
  }
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount > 1) {
    // 多个冒号：裸 IPv6 字面量（无端口；带端口必须用方括号形式）。
    return trimmed;
  }
  if (colonCount === 1) {
    const colonIndex = trimmed.lastIndexOf(":");
    if (!isValidPortSuffix(trimmed.slice(colonIndex))) {
      return null;
    }
    return trimmed.slice(0, colonIndex);
  }
  return trimmed;
}

/** 按实际监听端口解析生效的 Origin 允许列表。 */
export function resolveAllowedOrigins(
  config: RuntimeConfig,
  actualPort: number,
): readonly string[] {
  if (config.allowedOrigins !== undefined) {
    return config.allowedOrigins;
  }
  return config.allowedHosts.map((host) =>
    host.includes(":") ? `http://[${host}]:${actualPort}` : `http://${host}:${actualPort}`,
  );
}

export type ConfigLogLevel = LogLevel;
