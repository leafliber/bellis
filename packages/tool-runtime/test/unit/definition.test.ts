import { describe, expect, it } from "vitest";
import type { ToolDeclaration } from "../../src/index.js";
import { checkToolDeclaration } from "../../src/index.js";

const valid: ToolDeclaration = {
  name: "lookup_quest",
  version: 1,
  description: "查询当前任务进度",
  inputSchema: { type: "object", properties: { questId: { type: "string" } } },
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
  cache: { l1: true, l2: true, ttlMs: 60_000, revision: "v1" },
};

describe("checkToolDeclaration", () => {
  it("accepts a well-formed pure parallel_read tool", () => {
    expect(checkToolDeclaration(valid).ok).toBe(true);
  });

  it("rejects invalid names and versions", () => {
    expect(checkToolDeclaration({ ...valid, name: "Lookup-Quest" }).issues).toContain(
      "name_invalid",
    );
    expect(checkToolDeclaration({ ...valid, version: 0 }).issues).toContain("version_invalid");
  });

  it("rejects unbounded timeouts and output budgets", () => {
    expect(checkToolDeclaration({ ...valid, timeoutMs: 120_001 }).issues).toContain(
      "timeout_invalid",
    );
    expect(checkToolDeclaration({ ...valid, outputMaxBytes: 0 }).issues).toContain(
      "output_budget_invalid",
    );
  });

  it("rejects declaration contradictions at registration time", () => {
    // exclusive 必须声明 resource
    expect(
      checkToolDeclaration({ ...valid, executionMode: "exclusive", resource: null }).issues,
    ).toContain("execution_mode_conflict");
    // keyed 必须声明 keyArgument
    expect(
      checkToolDeclaration({ ...valid, executionMode: "keyed", keyArgument: null }).issues,
    ).toContain("execution_mode_conflict");
    // parallel_read 不得声明资源
    expect(checkToolDeclaration({ ...valid, resource: "state.db" }).issues).toContain(
      "execution_mode_conflict",
    );
    // pure 不得要求确认
    expect(checkToolDeclaration({ ...valid, requiresConfirmation: true }).issues).toContain(
      "semantic_conflict",
    );
    // non_idempotent 不得声明缓存
    expect(
      checkToolDeclaration({
        ...valid,
        semantic: "non_idempotent",
        executionMode: "exclusive",
        resource: "gift-api",
      }).issues,
    ).toContain("cache_conflict");
    // background 不得要求确认
    expect(
      checkToolDeclaration({
        ...valid,
        executionMode: "background",
        semantic: "idempotent",
        cache: null,
        requiresConfirmation: true,
      }).issues,
    ).toContain("execution_mode_conflict");
  });
});
