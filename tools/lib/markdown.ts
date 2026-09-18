// Small Markdown rendering helpers shared by the generator.
import type { Schema } from "./registry.ts";

const cell = (value: unknown) =>
  String(value ?? "")
    .replaceAll("|", "&#124;")
    .replaceAll("\n", "<br>");

export function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

export const code = (value: string) => `\`${value}\``;

/** One-line description of a schema fragment for field tables. */
export function typeText(node: unknown): string {
  const s = (node ?? {}) as Schema;
  if (typeof s.$ref === "string") return s.$ref.split("/").at(-1) ?? "";
  if ("const" in s) return `固定 ${String(s.const)}`;
  if (Array.isArray(s.enum)) return s.enum.map(String).join(" / ");
  if (Array.isArray(s.oneOf)) return `oneOf(${s.oneOf.map(typeText).join(", ")})`;
  if (Array.isArray(s.anyOf)) return s.anyOf.map(typeText).join(" 或 ");
  let text = Array.isArray(s.type) ? s.type.join("/") : String(s.type ?? "按条件Schema");
  if (s.type === "array") text += `[${typeText(s.items)}]`;
  for (const key of ["minimum", "maximum", "minItems", "maxItems", "maxLength"]) {
    if (key in s) text += `; ${key}=${String(s[key])}`;
  }
  if (s.additionalProperties === false) text += "; 未列字段拒绝";
  return text;
}

export function fieldsTable(name: string, def: Schema): string {
  const properties = def.properties as Record<string, unknown> | undefined;
  if (!properties) return table(["类型", "结构"], [[name, typeText(def)]]);
  const required = new Set((def.required ?? []) as string[]);
  return table(
    ["字段", "必填", "类型／边界"],
    Object.entries(properties).map(([field, spec]) => [
      field,
      required.has(field) ? "是" : "否",
      typeText(spec),
    ]),
  );
}
