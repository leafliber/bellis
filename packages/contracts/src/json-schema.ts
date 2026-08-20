import { z } from "zod";
import { ActionFrameSchema } from "./decision/action-frame.js";
import { DecisionPacketSchema } from "./decision/decision-packet.js";
import {
  AvatarIntentSchema,
  GameIntentSchema,
  OverlayIntentSchema,
  SpeechIntentSchema,
  SyncPolicySchema,
} from "./decision/intents.js";
import { ToolCallSchema } from "./decision/tool-call.js";
import { ErrorEnvelopeSchema } from "./errors/error-envelope.js";
import { SceneSchema } from "./scene/scene.js";
import { CueSchema } from "./scene/cue.js";
import { AudienceBatchSchema } from "./signal/audience-batch.js";
import { SignalSchema } from "./signal/signal.js";
import { OutboxMessageSchema } from "./session/outbox-message.js";
import { Phase1SessionSnapshotSchema } from "./session/session-snapshot.js";
import { SessionRecordSchema } from "./session/session-record.js";
import {
  ClientControlEnvelopeSchema,
  ControlEnvelopeSchema,
  ServerControlEnvelopeSchema,
} from "./transport/control-envelope.js";
import { ControlPayloadSchema } from "./transport/control-payload.js";
import { MediaFrameHeaderSchema } from "./transport/media-frame-header.js";
import { TraceContextSchema } from "./common/trace-context.js";
import { JsonValueSchema } from "./common/json-value.js";

/**
 * JSON Schema 双目标生成（ADR 0001 §4）：
 * - Zod 4 Schema 是唯一源；`z.toJSONSchema` 分别输出 2020-12 与 Draft 7。
 * - 2020-12 供 OpenAPI 3.1 与对外契约；Draft 7 供 Fastify/Ajv 运行期验证与 LLM Tool。
 * - 生成物作为可审查产物提交入库，由 `pnpm contracts:check` 防漂移。
 * - 生成内容必须完全确定：不含时间戳、随机数或环境相关信息。
 *
 * 语义等价策略（Zod ⇔ 生成物，任意输入判定一致）：
 * - 协议对象显式二选一：闭合的规范形态用 strictObject（生成物为
 *   additionalProperties:false，未知键被拒），可前向扩展的数据对象用
 *   extensibleJsonObject（catch-all 为 JsonValueSchema，生成物为
 *   additionalProperties: JsonValueSchema——未知扩展键必须是 JSON 值）。
 *   不使用裸 z.object（strip 静默丢键），也不使用 z.looseObject（未知键
 *   不受约束，生成物 additionalProperties:{} 无法拒绝 bigint 等非 JSON 值）。
 * - DecisionPacket 顶层闭合：遗留顶层 message/speech 与一切未知顶层键
 *   被结构性拒绝（ADR 0001「不设置顶层 message 或 speech」的可执行化）。
 * - 不使用任何跨字段 refine；「至少一个行动」「noOp 互斥」「wordIndex
 *   必填」等约束全部以 union/discriminated-union/min(1) 结构表达。
 * - 生产者不变量（clock.pong 的 r2≥r1、批次水位顺序）不属于 Schema 约束，
 *   由 Transport/Persistence 在 bigint 域校验。
 * - 同一组合法/非法 Fixture 必须在 Zod、Ajv2020、AjvDraft7 三者上判定
 *   一致；不存在任何只被单侧拒绝的样本。
 */

/** 参与双目标生成的全部公开 Schema。key 即生成文件名。 */
export const CONTRACT_SCHEMA_ENTRIES = {
  "json-value": JsonValueSchema,
  "trace-context": TraceContextSchema,
  "error-envelope": ErrorEnvelopeSchema,
  signal: SignalSchema,
  "audience-batch": AudienceBatchSchema,
  "speech-intent": SpeechIntentSchema,
  "avatar-intent": AvatarIntentSchema,
  "game-intent": GameIntentSchema,
  "overlay-intent": OverlayIntentSchema,
  "sync-policy": SyncPolicySchema,
  "action-frame": ActionFrameSchema,
  "tool-call": ToolCallSchema,
  "decision-packet": DecisionPacketSchema,
  cue: CueSchema,
  scene: SceneSchema,
  "session-record": SessionRecordSchema,
  "phase1-session-snapshot": Phase1SessionSnapshotSchema,
  "outbox-message": OutboxMessageSchema,
  "server-control-envelope": ServerControlEnvelopeSchema,
  "client-control-envelope": ClientControlEnvelopeSchema,
  "control-envelope": ControlEnvelopeSchema,
  "control-payload": ControlPayloadSchema,
  "media-frame-header": MediaFrameHeaderSchema,
} as const satisfies Record<string, z.ZodType>;

export type ContractSchemaKey = keyof typeof CONTRACT_SCHEMA_ENTRIES;

export interface GeneratedSchemaFile {
  /** 相对于生成根目录的 POSIX 风格路径，如 `json-schema-2020-12/signal.json`。 */
  readonly path: string;
  readonly content: string;
}

const GENERATION_TARGETS = [
  {
    dir: "json-schema-2020-12",
    target: "draft-2020-12",
    dialect: "https://json-schema.org/draft/2020-12/schema",
  },
  {
    dir: "json-schema-draft-07",
    target: "draft-7",
    dialect: "http://json-schema.org/draft-07/schema#",
  },
] as const;

export function generateJsonSchemaFiles(): GeneratedSchemaFile[] {
  const files: GeneratedSchemaFile[] = [];
  for (const target of GENERATION_TARGETS) {
    const schemaKeys: string[] = [];
    for (const [key, schema] of Object.entries(CONTRACT_SCHEMA_ENTRIES)) {
      const json = z.toJSONSchema(schema, { target: target.target });
      schemaKeys.push(key);
      files.push({
        path: `${target.dir}/${key}.json`,
        content: `${JSON.stringify(json, null, 2)}\n`,
      });
    }
    const manifest = {
      target: target.target,
      dialect: target.dialect,
      schemas: schemaKeys.toSorted(),
    };
    files.push({
      path: `${target.dir}/manifest.json`,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    });
  }
  return files;
}
