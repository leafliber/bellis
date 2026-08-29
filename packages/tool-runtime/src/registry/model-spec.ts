import type { JsonValue } from "@bellis/contracts";
import type { ToolDeclaration } from "./definition.js";

/**
 * 进入 ModelRequest 的 Tool 描述（phase-3-development-guide.md §7.1）：
 * 只暴露名称、说明与 Draft 7 输入 Schema，不泄漏资源、权限、缓存或
 * 执行细节。Decision Loop 组装 ModelRequest 时从这里取规格。
 */
export interface ToolModelSpec {
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: JsonValue;
}

export function buildToolModelSpec(declaration: ToolDeclaration): ToolModelSpec {
  return {
    name: declaration.name,
    description: declaration.description,
    parametersSchema: declaration.inputSchema,
  };
}
