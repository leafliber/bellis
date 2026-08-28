import type { ToolDeclaration } from "./definition.js";
import { checkToolDeclaration } from "./definition.js";
import type { ToolHandler } from "../port.js";

/**
 * Tool Registry（phase-3-development-guide.md §8.1）。
 * 同名冲突、非法 Schema、无界 Timeout 或声明矛盾在注册期失败——
 * 不等模型调用后才猜测。注册后声明只读（版本变化 = 新注册替换，
 * 需显式升版）。
 */
export interface RegisteredTool {
  readonly declaration: ToolDeclaration;
  readonly handler: ToolHandler;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register(declaration: ToolDeclaration, handler: ToolHandler): void {
    const check = checkToolDeclaration(declaration);
    if (!check.ok) {
      throw new Error(`tool declaration invalid (${declaration.name}): ${check.issues.join(", ")}`);
    }
    const existing = this.#tools.get(declaration.name);
    if (existing !== undefined) {
      throw new Error(
        `tool name conflict: ${declaration.name} already registered (v${existing.declaration.version})`,
      );
    }
    this.#tools.set(declaration.name, { declaration, handler });
  }

  get(name: string): RegisteredTool | null {
    return this.#tools.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(): readonly ToolDeclaration[] {
    return [...this.#tools.values()].map((tool) => tool.declaration);
  }

  get size(): number {
    return this.#tools.size;
  }
}
