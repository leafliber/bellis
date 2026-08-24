import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Stage 静态托管（Phase 2 开发/Demo 装配，docs/phase-2-development-guide.md §10）。
 *
 * - 挂载点 /stage/*：读取 apps/stage 构建产物（base=/stage/），SPA 回退
 *   到 index.html（/stage/:profile 由前端路由解析）；
 * - 路径安全：resolve 后必须仍在根目录内（阻断 ../ 穿越）；
 * - 无新依赖：小而显式的文件服务（限定扩展名白名单与大小上限），
 *   不引入 @fastify/static；
 * - 仅在显式配置 phase2.stageDistDir 时注册；生产默认不挂载。
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** 单文件读取上限（构建产物远小于此；超出按 404 拒绝）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function registerStageStatic(app: FastifyInstance, rootDir: string): void {
  const root = resolve(rootDir);

  app.get("/stage/*", async (request, reply: FastifyReply) => {
    const wildcard = request.url.split("?")[0] ?? "/stage/";
    const relative = wildcard.slice("/stage/".length);
    await serveFromRoot(reply, root, decodeURIComponent(relative));
  });
  app.get("/stage", async (_request, reply: FastifyReply) => {
    await serveFromRoot(reply, root, "index.html");
  });
}

async function serveFromRoot(reply: FastifyReply, root: string, relative: string): Promise<void> {
  const safeRelative = normalize(relative).replaceAll("\\", "/");
  if (
    safeRelative.startsWith("..") ||
    safeRelative.includes(`..${sep}`) ||
    safeRelative.startsWith("/")
  ) {
    await reply.code(404).send({ code: "invalid_message", message: "not found" });
    return;
  }
  const candidates =
    safeRelative.length === 0 || safeRelative.endsWith("/")
      ? [join(root, safeRelative, "index.html")]
      : [join(root, safeRelative), join(root, safeRelative, "index.html")];
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (!resolved.startsWith(root + sep) && resolved !== root) {
      continue;
    }
    const info = await stat(resolved).catch(() => null);
    if (info === null || !info.isFile()) {
      continue;
    }
    if (info.size > MAX_FILE_BYTES) {
      continue;
    }
    const type = CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream";
    reply.header("content-type", type);
    reply.header("cache-control", "no-store");
    return reply.send(createReadStream(resolved));
  }
  // SPA 回退：未知路径返回应用外壳（前端 /stage/:profile 路由）。
  const indexPath = resolve(join(root, "index.html"));
  const indexInfo = await stat(indexPath).catch(() => null);
  if (indexInfo === null || !indexInfo.isFile() || indexInfo.size > MAX_FILE_BYTES) {
    await reply.code(404).send({ code: "invalid_message", message: "not found" });
    return;
  }
  reply.header("content-type", CONTENT_TYPES[".html"]!);
  reply.header("cache-control", "no-store");
  return reply.send(createReadStream(indexPath));
}
