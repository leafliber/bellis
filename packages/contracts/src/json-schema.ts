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

/**
 * JSON Schema 双目标生成（ADR 0001 §4）：
 * - Zod 4 Schema 是唯一源；`z.toJSONSchema` 分别输出 2020-12 与 Draft 7。
 * - 2020-12 供 OpenAPI 3.1 与对外契约；Draft 7 供 Fastify/Ajv 运行期验证与 LLM Tool。
 * - 生成物作为可审查产物提交入库，由 `pnpm contracts:check` 防漂移。
 * - 生成内容必须完全确定：不含时间戳、随机数或环境相关信息。
 * - Zod 侧的跨字段 refine（如 Envelope 方向约束、水位顺序）无法映射到
 *   JSON Schema，属于 Zod 运行期校验语义；两套 dialect 生成物共享同一
 *   Fixture 做语义等价测试，Fixture 覆盖这些约束的输入面。
 */

/** 参与双目标生成的全部公开 Schema。key 即生成文件名。 */
export const CONTRACT_SCHEMA_ENTRIES = {
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
