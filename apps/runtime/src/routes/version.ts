import type { FastifyInstance } from "fastify";
import { CONTROL_PROTOCOL_VERSION } from "@bellis/contracts";
import { MEDIA_FRAME_PROTOCOL_VERSION } from "@bellis/transport";
import type { RouteContext } from "./context.js";

/**
 * Version 路由（P4 文档 §7.3）：应用版本、Control/Media 协议版本、
 * 构建信息与 Runtime Instance ID。不返回 Token、路径或环境变量。
 */
export function registerVersionRoute(app: FastifyInstance, ctx: RouteContext): void {
  app.get("/api/v1/version", async () => {
    return {
      version: ctx.config.runtimeVersion,
      protocol: {
        control: CONTROL_PROTOCOL_VERSION,
        media: MEDIA_FRAME_PROTOCOL_VERSION,
      },
      buildInfo: ctx.config.buildInfo,
      runtimeInstanceId: ctx.instanceId,
    };
  });
}
