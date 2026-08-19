import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, describe, it } from "vitest";
import { CONTRACT_SCHEMA_ENTRIES, generateJsonSchemaFiles } from "../src/json-schema.js";
import { SCHEMA_FIXTURES } from "./fixtures.js";

/**
 * ajv 是 CJS 包，其子路径（dist/2020）与默认导出在 TypeScript 7 的
 * nodenext 解析下类型不稳定（无子路径类型映射、CJS 默认互操作异常）。
 * 测试通过 createRequire 在运行时加载，并用最小本地接口约束使用面，
 * 避免为第三方包手写整套类型声明。
 */
interface CompileOptions {
  strict?: boolean;
}
interface ValidatorConstructor {
  new (options?: CompileOptions): { compile(schema: object): (data: unknown) => boolean };
}

const require = createRequire(import.meta.url);
const AjvDraft7 = require("ajv") as unknown as ValidatorConstructor;
const Ajv2020 = require("ajv/dist/2020") as unknown as ValidatorConstructor;

/**
 * JSON Schema 双目标语义等价测试（ADR 0001 §4）：
 * - 提交入库的 2020-12 与 Draft 7 生成物用同一组合法/非法 Fixture 验证。
 * - valid 三者（Zod / Ajv2020 / AjvDraft7）都必须接受；
 *   invalid 三者都必须拒绝；refinementOnly 只被 Zod 拒绝（跨字段约束
 *   无法映射到 JSON Schema，属文档化的运行期语义）。
 */

const generatedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../generated");

const ajvDraft7 = new AjvDraft7();
const ajv2020 = new Ajv2020();

function loadGenerated(dir: string, key: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(generatedRoot, dir, `${key}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("generated JSON Schema artifacts", () => {
  it("generation is deterministic", () => {
    expect(generateJsonSchemaFiles()).toEqual(generateJsonSchemaFiles());
  });

  it("committed artifacts match current generation", () => {
    for (const file of generateJsonSchemaFiles()) {
      const committed = readFileSync(join(generatedRoot, file.path), "utf8");
      expect(committed, file.path).toBe(file.content);
    }
  });

  it("manifests list every schema key", () => {
    for (const dir of ["json-schema-2020-12", "json-schema-draft-07"]) {
      const manifest = JSON.parse(
        readFileSync(join(generatedRoot, dir, "manifest.json"), "utf8"),
      ) as {
        schemas: string[];
      };
      expect(manifest.schemas.toSorted()).toEqual(Object.keys(CONTRACT_SCHEMA_ENTRIES).toSorted());
    }
  });
});

describe("semantic equivalence across Zod / 2020-12 / Draft 7", () => {
  const validate2020 = new Map<string, (data: unknown) => boolean>();
  const validateDraft7 = new Map<string, (data: unknown) => boolean>();
  for (const key of Object.keys(CONTRACT_SCHEMA_ENTRIES)) {
    validate2020.set(key, ajv2020.compile(loadGenerated("json-schema-2020-12", key)));
    validateDraft7.set(key, ajvDraft7.compile(loadGenerated("json-schema-draft-07", key)));
  }

  it.each(Object.entries(SCHEMA_FIXTURES))(
    "%s: fixtures agree across dialects",
    (key, fixtures) => {
      const schema = CONTRACT_SCHEMA_ENTRIES[key as keyof typeof CONTRACT_SCHEMA_ENTRIES];
      const v2020 = validate2020.get(key);
      const vDraft7 = validateDraft7.get(key);
      if (v2020 === undefined || vDraft7 === undefined) {
        throw new Error(`missing compiled validator for ${key}`);
      }
      for (const sample of fixtures.valid) {
        expect(schema.safeParse(sample).success, `${key} zod should accept`).toBe(true);
        expect(v2020(sample), `${key} ajv2020 should accept`).toBe(true);
        expect(vDraft7(sample), `${key} ajv draft7 should accept`).toBe(true);
      }
      for (const sample of fixtures.invalid) {
        expect(schema.safeParse(sample).success, `${key} zod should reject`).toBe(false);
        expect(v2020(sample), `${key} ajv2020 should reject`).toBe(false);
        expect(vDraft7(sample), `${key} ajv draft7 should reject`).toBe(false);
      }
    },
  );

  it("no fixture is accepted by only one validator (equivalence has no exceptions)", () => {
    // 上面的 it.each 已逐样本断言三方一致；此用例固化「不存在 refinementOnly
    // 类别」的规则本身：Fixture 注册表只允许 valid / invalid 两类。
    for (const fixtures of Object.values(SCHEMA_FIXTURES)) {
      expect(Object.keys(fixtures).toSorted()).toEqual(["invalid", "valid"]);
    }
  });
});
