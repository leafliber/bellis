import { describe, expect, it } from "vitest";
import type { ToolCall } from "@bellis/contracts";
import { ToolRegistry, compileDag } from "../../src/index.js";
import type { ToolDeclaration } from "../../src/index.js";
import type { ToolHandler } from "../../src/index.js";

function declaration(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: "lookup_quest",
    version: 1,
    description: "查询任务",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    outputMaxBytes: 4096,
    sensitiveOutputFields: [],
    executionMode: "parallel_read",
    semantic: "pure",
    resource: null,
    keyArgument: null,
    timeoutMs: 5_000,
    cancellable: true,
    maxConcurrency: 4,
    requiredCapabilities: [],
    requiresConfirmation: false,
    cache: { l1: true, l2: false, ttlMs: 60_000, revision: "v1" },
    ...overrides,
  };
}

const handler: ToolHandler = async () => ({ value: { ok: true } });

function call(
  toolRunId: string,
  toolName = "lookup_quest",
  args: Record<string, unknown> = {},
  dependsOn?: string[],
): ToolCall {
  return {
    schemaVersion: 1,
    toolRunId,
    toolName,
    arguments: args,
    ...(dependsOn === undefined ? {} : { dependsOn }),
  } as ToolCall;
}

function registryWith(...declarations: ToolDeclaration[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const entry of declarations) {
    registry.register(entry, handler);
  }
  return registry;
}

const RUN = (n: number): string =>
  `${(n + 0x10).toString(16).repeat(8).slice(0, 8)}-8888-4888-8888-888888888888`;

describe("compileDag", () => {
  it("compiles independent tools into one parallel layer", () => {
    const registry = registryWith(declaration());
    const result = compileDag(registry, [call(RUN(1)), call(RUN(2))]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layers).toHaveLength(1);
      expect(result.layers[0]).toHaveLength(2);
    }
  });

  it("orders dependencies into deterministic layers", () => {
    const registry = registryWith(declaration());
    const result = compileDag(registry, [
      call(RUN(1)),
      call(RUN(2), "lookup_quest", {}, [RUN(1)]),
      call(RUN(3), "lookup_quest", {}, [RUN(2)]),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layers.map((layer) => layer.map((node) => node.call.toolRunId))).toEqual([
        [RUN(1)],
        [RUN(2)],
        [RUN(3)],
      ]);
    }
  });

  it("rejects cycles", () => {
    const registry = registryWith(declaration());
    const result = compileDag(registry, [
      call(RUN(1), "lookup_quest", {}, [RUN(2)]),
      call(RUN(2), "lookup_quest", {}, [RUN(1)]),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === "dependency_cycle")).toBe(true);
    }
  });

  it("rejects unknown tools, duplicate ids and missing dependencies", () => {
    const registry = registryWith(declaration());
    const unknown = compileDag(registry, [call(RUN(1), "nope")]);
    expect(unknown.issues.some((issue) => issue.code === "unknown_tool")).toBe(true);
    const duplicate = compileDag(registry, [call(RUN(1)), call(RUN(1))]);
    expect(duplicate.issues.some((issue) => issue.code === "duplicate_tool_run_id")).toBe(true);
    const missing = compileDag(registry, [call(RUN(1), "lookup_quest", {}, [RUN(9)])]);
    expect(missing.issues.some((issue) => issue.code === "dependency_unknown")).toBe(true);
  });

  it("rejects dependencies on background tools", () => {
    const registry = registryWith(
      declaration(),
      declaration({
        name: "log_audit",
        executionMode: "background",
        semantic: "idempotent",
        cache: null,
      }),
    );
    const result = compileDag(registry, [
      call(RUN(1), "log_audit"),
      call(RUN(2), "lookup_quest", {}, [RUN(1)]),
    ]);
    expect(result.issues.some((issue) => issue.code === "dependency_on_background")).toBe(true);
  });

  it("rejects more than 8 nodes and excessive depth", () => {
    const registry = registryWith(declaration());
    const tooMany = compileDag(
      registry,
      Array.from({ length: 9 }, (_, index) => call(RUN(index + 1))),
    );
    expect(tooMany.issues.some((issue) => issue.code === "too_many_nodes")).toBe(true);
    const tooDeep = compileDag(
      registry,
      Array.from({ length: 5 }, (_, index) =>
        call(RUN(index + 1), "lookup_quest", {}, index === 0 ? undefined : [RUN(index)]),
      ),
    );
    expect(tooDeep.issues.some((issue) => issue.code === "depth_exceeded")).toBe(true);
  });

  it("builds keyed lock keys from normalized argument values", () => {
    const registry = registryWith(
      declaration({ name: "read_player", executionMode: "keyed", keyArgument: "playerId" }),
    );
    const result = compileDag(registry, [call(RUN(1), "read_player", { playerId: "Alice" })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nodes[0]?.lockKey).toBe("keyed:read_player:alice");
    }
    const invalid = compileDag(registry, [call(RUN(2), "read_player", {})]);
    expect(invalid.issues.some((issue) => issue.code === "keyed_argument_invalid")).toBe(true);
  });
});

describe("ToolRegistry", () => {
  it("rejects duplicate names at registration", () => {
    const registry = registryWith(declaration());
    expect(() => registry.register(declaration(), handler)).toThrow(/conflict/);
  });
});
