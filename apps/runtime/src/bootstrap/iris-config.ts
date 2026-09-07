import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { MemoryActorSchema } from "@bellis/contracts/memory";
import { parseRuntimeConfig, type RuntimeConfig } from "./config.js";

const text = z.string().min(1).max(256);
const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        value === url.origin &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
const credential = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("environment"),
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u),
  }),
  z.strictObject({ kind: z.literal("file"), path: z.string().min(1).max(4096).refine(isAbsolute) }),
]);
const enabledIris = z
  .strictObject({
    enabled: z.literal(true),
    baseUrl: origin,
    allowedOrigins: z.array(origin).min(1).max(16),
    credential,
    activeSurfaceMode: z.literal("off").default("off"),
    appInstanceId: text,
    agentId: text,
    spaceId: text,
    identityScope: text,
    privacyRevision: text,
    scope: z.strictObject({ kind: z.literal("space"), acknowledgeCrossSession: z.literal(true) }),
    actors: z.array(MemoryActorSchema).min(1).max(32),
    publicLabels: z.array(text).max(32),
    observeOutput: z.strictObject({ privacyLabels: z.array(text).min(1).max(32) }).optional(),
    coreSchema: z
      .strictObject({
        minimum: z.number().int().positive().max(65535),
        maximum: z.number().int().positive().max(65535),
      })
      .default({ minimum: 14, maximum: 15 }),
    deadlineMs: z.number().int().min(150).max(250).default(200),
    maxInputTokens: z.number().int().min(1).max(65536).default(16000),
    memoryTokenBudget: z.number().int().min(1).max(65536).default(2000),
    refreshIntervalMs: z.number().int().min(100).max(60000).default(1000),
    historyRecovery: z
      .strictObject({
        intervalMs: z.number().int().min(100).max(60000).default(30000),
        timeoutMs: z.number().int().min(1).max(60000).default(60000),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      !value.allowedOrigins.includes(value.baseUrl) ||
      value.coreSchema.minimum > value.coreSchema.maximum
    )
      ctx.addIssue({ code: "custom", message: "invalid origin or schema range" });
  });
const schema = z.strictObject({
  schemaVersion: z.literal(1),
  runtime: z.unknown(),
  iris: z.union([z.strictObject({ enabled: z.literal(false) }), enabledIris]),
});

export type IrisLaunchConfig = z.output<typeof enabledIris>;
export interface LoadedIrisConfiguration {
  readonly runtime: RuntimeConfig;
  readonly iris: { readonly enabled: false } | IrisLaunchConfig;
  /** Kept outside RuntimeConfig; never log/serialize this loader result. */
  readonly bearerToken?: string;
}

/** Read through one descriptor, cap allocation even when the file grows, reject
 * symlinks/devices and (on POSIX) credentials accessible to other accounts. */
async function readBoundedFile(path: string, limit: number, secret: boolean): Promise<string> {
  if (!isAbsolute(path)) throw new Error("iris_config_invalid");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > limit ||
      (secret &&
        process.getuid !== undefined &&
        (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    )
      throw new Error("iris_config_invalid");
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > limit) throw new Error("iris_config_invalid");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    await file.close();
  }
}

/** No input text, filenames, environment values or nested exception causes escape
 * this boundary. Disabled configuration never resolves a credential reference. */
export async function loadIrisRuntimeConfiguration(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LoadedIrisConfiguration> {
  try {
    const parsed = schema.parse(JSON.parse(await readBoundedFile(path, 65536, false)));
    const runtime = parseRuntimeConfig(parsed.runtime);
    if (!runtime.ok || runtime.config.phase2.faultPoint !== undefined) throw new Error();
    if (!parsed.iris.enabled) return { runtime: runtime.config, iris: parsed.iris };
    if (!runtime.config.phase2.enabled || !runtime.config.phase3.enabled) throw new Error();
    const reference = parsed.iris.credential;
    const token =
      reference.kind === "environment"
        ? environment[reference.name]
        : (await readBoundedFile(reference.path, 8193, true)).replace(/\r?\n$/u, "");
    if (token === undefined || !/^[A-Za-z0-9\-._~+/]+=*$/u.test(token) || token.length > 8192)
      throw new Error();
    return { runtime: runtime.config, iris: parsed.iris, bearerToken: token };
  } catch {
    throw new Error("iris_launch_configuration_invalid");
  }
}
