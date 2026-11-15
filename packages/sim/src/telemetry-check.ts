import {
  attributeAllowed,
  Metric,
  type OtlpMetrics,
  type OtlpTraces,
  otlpLineProblems,
} from '@bellis/telemetry';
import type { History } from './invariants.ts';

type OtlpSpan = OtlpTraces['resourceSpans'][number]['scopeSpans'][number]['spans'][number];
type KeyValues = NonNullable<OtlpSpan['attributes']>;

/** 本项目写出的属性值（OTLP/JSON 的四种之一）。 */
function decoded(entry: KeyValues[number]): string | number | boolean {
  const value = entry.value;
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return value.doubleValue;
  return value.boolValue;
}

function attribute(span: OtlpSpan, key: string): string | number | boolean | undefined {
  const found = span.attributes?.find((entry) => entry.key === key);
  return found ? decoded(found) : undefined;
}

/** 内容的片段：短于 4 个字符的不比（例如投票的编号“1”与属性里的数字会碰巧相同）。 */
const MIN_CONTENT = 4;

/**
 * 遥测的不变量（见运维“观测”与“确定性仿真”）：
 * 1. 每一行都是本项目写出的 OTLP/JSON（结构、时刻、桶计数），span ID 不重复；
 * 2. 内容不采集：属性名都过准入规则，任何属性值都不含送出的弹幕正文、昵称与 Stage 上的字幕；
 * 3. 每一段回应了弹幕、已经写回、且有句子在 Stage 上开始播出的发言（含开票说明），它开始播出的每一句都能沿
 *    父 span 在同一 trace 里追到那条弹幕（意图来源里的第一条输入）的根 span `danmaku.receive`；
 *    途中每个 span 都已写出；这一句的播出 span 带“开始播出”事件；
 * 4. 回应弹幕的发言（父为分诊候选）第一句开始播出时恰好记了一个“弹幕到首音”样本，值等于这一刻与根 span
 *    开始的时间差，“加呈现延迟”的样本再多出当时的呈现延迟。
 */
export function checkTelemetry(history: History): string[] {
  const lines = history.telemetry;
  if (!lines) return [];
  const violations: string[] = [];
  const spans = new Map<string, OtlpSpan>();
  const strings: string[] = [];
  const exemplars = new Map<string, Array<{ value: number; spanId: string | undefined }>>();
  const keep = (entries: KeyValues | undefined, where: string) => {
    for (const entry of entries ?? []) {
      if (!attributeAllowed(entry.key) && where !== 'resource') {
        violations.push(`${where} 的属性 ${entry.key} 不该写出`);
      }
      const value = decoded(entry);
      if (typeof value === 'string') strings.push(value);
    }
  };

  for (const [index, line] of lines.entries()) {
    const problems = otlpLineProblems(line);
    if (problems.length > 0) {
      violations.push(`遥测第 ${index + 1} 行不合格：${problems.join('；')}`);
      continue;
    }
    const request = JSON.parse(line) as Partial<OtlpTraces & OtlpMetrics>;
    for (const resource of request.resourceSpans ?? []) {
      keep(resource.resource.attributes, 'resource');
      for (const scoped of resource.scopeSpans) {
        for (const span of scoped.spans) {
          if (spans.has(span.spanId)) violations.push(`span ID ${span.spanId} 重复`);
          spans.set(span.spanId, span);
          keep(span.attributes, `span ${span.name}`);
          for (const event of span.events ?? []) keep(event.attributes, `事件 ${event.name}`);
        }
      }
    }
    for (const resource of request.resourceMetrics ?? []) {
      for (const scoped of resource.scopeMetrics) {
        for (const metric of scoped.metrics) {
          const list = exemplars.get(metric.name) ?? [];
          exemplars.set(metric.name, list);
          for (const point of metric.histogram.dataPoints) {
            keep(point.attributes, `直方图 ${metric.name}`);
            for (const exemplar of point.exemplars) {
              list.push({ value: exemplar.asDouble, spanId: exemplar.spanId });
            }
          }
        }
      }
    }
  }

  // 内容：送出的弹幕正文与昵称、Stage 上开始的字幕。
  const contents = new Set<string>();
  for (const entry of history.trace) {
    const pieces =
      entry.kind === 'danmaku.delivered'
        ? [entry.data.text, entry.data.nickname]
        : entry.kind === 'page.begin'
          ? [entry.data.subtitle]
          : [];
    for (const piece of pieces) {
      if (typeof piece === 'string' && piece.length >= MIN_CONTENT) contents.add(piece);
    }
  }
  for (const value of strings) {
    for (const content of contents) {
      if (value.includes(content)) violations.push(`遥测属性值含有内容：${content}`);
    }
  }

  // 意图来源：句键 → 来源与输入。
  const sources = new Map<string, { origin: string; inputs: string[] }>();
  type GameVote = { runtimeId: string; decisionPoint: string; seq: number; recordedAt: number };
  const gameOpenings = new Map<string, GameVote>();
  const gameDecisions = new Map<string, GameVote>();
  const openingDecisions = new Map<string, GameVote>();
  const gameFactOrder = new Map<number, { boot: number; index: number }>();
  let boot = 0;
  for (const [index, entry] of history.trace.entries()) {
    if (entry.kind === 'world.start') boot = index;
    if (entry.kind === 'fact.decision_point.opened' || entry.kind === 'fact.vote.started')
      gameFactOrder.set(Number(entry.data.factSeq), { boot, index });
  }
  for (const event of history.events) {
    if (event.type === 'vote.started') {
      const vote = event.data as {
        voteId: string;
        decisionPoint: string;
        game?: { runtimeId: string };
      };
      if (vote.game)
        gameOpenings.set(`vote:${vote.voteId}:opening`, {
          runtimeId: vote.game.runtimeId,
          decisionPoint: vote.decisionPoint,
          seq: event.seq,
          recordedAt: event.recordedAt,
        });
    } else if (event.type === 'decision_point.opened') {
      const fact = event.data as { runtimeId: string; payload: { decisionPointId: string } };
      gameDecisions.set(`game:${event.seq}`, {
        runtimeId: fact.runtimeId,
        decisionPoint: fact.payload.decisionPointId,
        seq: event.seq,
        recordedAt: event.recordedAt,
      });
    }
    if (event.type !== 'intent.authorized') continue;
    const data = event.data as {
      key: string;
      type: string;
      source: { origin: string; inputs: string[] };
    };
    if (data.type !== 'speech.play') continue;
    sources.set(data.key, data.source);
    const vote = gameOpenings.get(data.key.replace(/#\d+$/u, ''));
    if (!vote) continue;
    const voteTrace = gameFactOrder.get(vote.seq);
    const point = data.source.inputs
      .map((input) => gameDecisions.get(input))
      .find((decision) => {
        if (
          !decision ||
          decision.runtimeId !== vote.runtimeId ||
          decision.decisionPoint !== vote.decisionPoint
        )
          return false;
        const pointTrace = gameFactOrder.get(decision.seq);
        return (
          decision.seq < vote.seq &&
          vote.seq < event.seq &&
          pointTrace !== undefined &&
          voteTrace !== undefined &&
          pointTrace.boot === voteTrace.boot &&
          pointTrace.index < voteTrace.index
        );
      });
    if (!point || data.source.origin !== 'danmaku-reply') {
      violations.push(`游戏投票开场没有关联持久决策点 ${data.key}`);
      continue;
    }
    openingDecisions.set(data.key, point);
  }
  const sentenceSpans = new Map<string, OtlpSpan>();
  for (const span of spans.values()) {
    const key = attribute(span, 'bellis.speech.sentence_key');
    if (span.name === 'speech.sentence' && typeof key === 'string') sentenceSpans.set(key, span);
  }
  const stageSpans = new Map<string, OtlpSpan>();
  for (const span of spans.values()) {
    if (span.name === 'stage.play' && span.parentSpanId) stageSpans.set(span.parentSpanId, span);
  }

  // 按启动分段：一段发言只在一个进程里播出与写回。
  const segments: Array<{ started: string[]; written: Set<string> }> = [];
  for (const entry of history.trace) {
    if (entry.kind === 'world.start') segments.push({ started: [], written: new Set() });
    const segment = segments.at(-1);
    if (!segment) continue;
    if (entry.kind === 'page.started') segment.started.push(String(entry.data.sentenceId));
    if (entry.kind === 'fact.utterance') segment.written.add(String(entry.data.id));
  }

  const firstAudio = exemplars.get(Metric.DanmakuFirstAudio) ?? [];
  const presented = exemplars.get(Metric.DanmakuFirstAudioPresented) ?? [];
  for (const segment of segments) {
    const seen = new Set<string>();
    for (const key of segment.started) {
      const utterance = key.replace(/#\d+$/u, '');
      const source = sources.get(key);
      const gameVote = gameOpenings.get(utterance);
      if (
        !segment.written.has(utterance) ||
        (!gameVote && (source?.origin !== 'danmaku-reply' || source.inputs.length === 0))
      ) {
        continue;
      }
      const sentence = sentenceSpans.get(key);
      if (!sentence) {
        violations.push(`回应弹幕的句子 ${key} 开始播出，但没有它的 span`);
        continue;
      }
      const stage = stageSpans.get(sentence.spanId);
      const startedEvent = stage?.events?.find((event) => event.name === 'bellis.stage.started');
      if (!startedEvent) violations.push(`句子 ${key} 的播出 span 没有“开始播出”事件`);
      // 沿父 span 走到根。
      const chain: OtlpSpan[] = [sentence];
      let broken = false;
      for (let current = sentence; current.parentSpanId !== undefined; ) {
        const parent = spans.get(current.parentSpanId);
        if (!parent || parent.traceId !== current.traceId || chain.length > 64) {
          violations.push(`句子 ${key} 的链路在 ${current.name} 处断开`);
          broken = true;
          break;
        }
        chain.push(parent);
        current = parent;
      }
      if (broken) continue;
      const root = chain.at(-1) as OtlpSpan;
      const expected = source?.inputs[0];
      if (gameVote) {
        const point = openingDecisions.get(key);
        const director = chain.find(
          (span) =>
            span.name === 'chat replay' &&
            attribute(span, 'bellis.director.action') === 'game_vote',
        );
        if (
          !point ||
          !director ||
          BigInt(director.startTimeUnixNano) < BigInt(point.recordedAt) * 1_000_000n ||
          BigInt(director.startTimeUnixNano) > BigInt(gameVote.recordedAt) * 1_000_000n
        ) {
          violations.push(`游戏投票开场没有关联持久决策点和模型决策链路 ${key}`);
          continue;
        }
      } else if (
        root.name !== 'danmaku.receive' ||
        attribute(root, 'bellis.danmaku.id') !== expected
      ) {
        violations.push(
          `句子 ${key} 追到的根是 ${root.name}（${String(attribute(root, 'bellis.danmaku.id'))}），不是弹幕 ${expected} 的接入`,
        );
        continue;
      }

      // 弹幕到首音：回应弹幕的发言（父为分诊候选）第一句开始播出时记一次。
      if (seen.has(utterance)) continue;
      seen.add(utterance);
      const utteranceSpan = spans.get(sentence.parentSpanId as string);
      const reply =
        !gameVote && utteranceSpan?.parentSpanId
          ? spans.get(utteranceSpan.parentSpanId)?.name === 'triage.candidate'
          : false;
      const samples = firstAudio.filter((sample) => sample.spanId === sentence.spanId);
      if (!reply || !startedEvent) {
        if (samples.length > 0) violations.push(`句子 ${key} 不该记“弹幕到首音”`);
        continue;
      }
      const elapsed =
        Number(BigInt(startedEvent.timeUnixNano) - BigInt(root.startTimeUnixNano)) / 1e9;
      if (samples.length !== 1 || Math.abs((samples[0]?.value ?? Number.NaN) - elapsed) > 1e-6) {
        violations.push(
          `发言 ${utterance} 的“弹幕到首音”样本 ${JSON.stringify(samples.map((s) => s.value))}，应为 [${elapsed}]`,
        );
      }
      const delay = Number(attribute(stage as OtlpSpan, 'bellis.stage.presentation_delay_ms') ?? 0);
      const shown = presented.filter((sample) => sample.spanId === sentence.spanId);
      if (
        shown.length !== 1 ||
        Math.abs((shown[0]?.value ?? Number.NaN) - (elapsed + delay / 1000)) > 1e-6
      ) {
        violations.push(`发言 ${utterance} 的“加呈现延迟”样本不等于首音加 ${delay}ms`);
      }
    }
  }
  return violations;
}
