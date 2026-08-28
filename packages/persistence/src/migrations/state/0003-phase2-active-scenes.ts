import type { MigrationDefinition } from "../definition.js";

/**
 * state.db 0003：Phase 2 活动 Scene 索引（scene-execution.md §8）。
 *
 * - appendRecord 在 scene_lifecycle Record 落库的同事务内维护
 *   active_scenes：非终态转换 UPSERT、可证终态（completed/cancelled/
 *   failed）DELETE——「任一未证终态」由索引直接回答，不受记录窗口
 *   挤出影响（长期在途的旧 Scene 不会因新 Scene 流量被遗忘）。
 * - **回填既有事实**：只建空表会让 0001/0002 时代的库在升级后把全部
 *   升级前在途 Scene 误判为「无活动」（恢复快照错误回落 v1）。回填与
 *   写侧（maintainActiveSceneIndex）同规：每 (session, scene) 取最新
 *   生命周期 Record——**以 aggregate sequence 的严格递增为权威**（与
 *   写侧一致；墙钟 occurred_at_ms 仅作无 seq 时的决胜）；payload 可信
 *   （v1 + 字段形态 + **UUID 形状**，与 UuidSchema 同规）才采用其
 *   to/cycleId，否则 sceneId 回退 aggregate_id 前缀、state 保守落
 *   unknown（未证终态）；可证终态不产生行。
 * - SQL 细节：SQLite 不保证 AND 短路求值，json_* 对非法 JSON 会抛错
 *   ——全部 JSON 读取都包在 CASE WHEN json_valid(...) 惰性分支内；
 *   静态 SQL，无拼接通道。
 */
export const statePhase2ActiveScenes: MigrationDefinition = {
  version: 3,
  name: "phase2-active-scenes",
  sql: `
CREATE TABLE active_scenes (
  session_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  cycle_id TEXT,
  state TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, scene_id)
) STRICT;

INSERT INTO active_scenes (session_id, scene_id, cycle_id, state, updated_at_ms)
SELECT session_id, scene_id, cycle_id, state, occurred_at_ms
FROM (
  SELECT session_id, scene_id, cycle_id, state, occurred_at_ms,
    ROW_NUMBER() OVER (
      PARTITION BY session_id, scene_id
      ORDER BY (aggregate_seq IS NULL),
        LENGTH(aggregate_seq) DESC,
        aggregate_seq DESC,
        occurred_at_ms DESC,
        record_id DESC
    ) AS rn
  FROM (
    SELECT session_id, record_id, aggregate_seq, occurred_at_ms,
      CASE
        WHEN trusted = 1 THEN payload_scene_id
        WHEN aggregate_id LIKE 'scene-lifecycle:%'
        THEN substr(aggregate_id, length('scene-lifecycle:') + 1)
      END AS scene_id,
      CASE WHEN trusted = 1 THEN payload_cycle_id END AS cycle_id,
      CASE WHEN trusted = 1 THEN payload_to ELSE 'unknown' END AS state
    FROM (
      SELECT session_id, record_id, occurred_at_ms, aggregate_id, aggregate_seq,
        CASE
          WHEN payload_version = 1
            AND payload_scene_id GLOB '????????-????-????-????-????????????'
            AND payload_scene_id NOT GLOB '*[^0-9a-fA-F-]*'
            AND payload_cycle_id GLOB '????????-????-????-????-????????????'
            AND payload_cycle_id NOT GLOB '*[^0-9a-fA-F-]*'
            AND typeof(payload_from) = 'text'
            AND typeof(payload_to) = 'text'
            AND length(payload_from) BETWEEN 1 AND 32
            AND length(payload_to) BETWEEN 1 AND 32
          THEN 1 ELSE 0
        END AS trusted,
        payload_scene_id, payload_cycle_id, payload_to
      FROM (
        SELECT session_id AS session_id,
          record_id AS record_id,
          occurred_at_ms AS occurred_at_ms,
          aggregate_id AS aggregate_id,
          aggregate_seq AS aggregate_seq,
          CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.payloadVersion') END AS payload_version,
          CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.sceneId') END AS payload_scene_id,
          CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.cycleId') END AS payload_cycle_id,
          CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.from') END AS payload_from,
          CASE WHEN json_valid(payload_json)
            THEN json_extract(payload_json, '$.to') END AS payload_to
        FROM session_records
        WHERE record_type = 'scene_lifecycle'
      ) decoded
    ) resolved
  ) keyed
) ranked
WHERE ranked.rn = 1
  AND ranked.scene_id IS NOT NULL
  AND ranked.scene_id <> ''
  AND ranked.state NOT IN ('completed', 'cancelled', 'failed');
`,
};
