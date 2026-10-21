/**
 * 属性与指标的名字（R-21）。GenAI 的部分按 open-telemetry/semantic-conventions-genai 锁定的提交
 * {@link GENAI_SEMCONV_COMMIT}（2026-10-18）；升级要改这里的提交并核对名字。自定义的一律用 `bellis.*`。
 * 承载内容的 GenAI 属性（输入输出消息、系统指令等）不采集，见 `attributes.ts`。
 */
export const GENAI_SEMCONV_COMMIT = '547934afa90a34298441caf80c43b27255c3a292';

/**
 * GenAI 语义约定（只用不含内容的部分）。该提交里 token 用量的指标是计数器
 * （`gen_ai.client.inference.usage.*`），本实现只写直方图，所以用量只记在 span 上，不写指标。
 */
export const GenAi = {
  OperationName: 'gen_ai.operation.name',
  ProviderName: 'gen_ai.provider.name',
  RequestModel: 'gen_ai.request.model',
  ResponseModel: 'gen_ai.response.model',
  UsageInputTokens: 'gen_ai.usage.input_tokens',
  UsageOutputTokens: 'gen_ai.usage.output_tokens',
  UsageReasoningOutputTokens: 'gen_ai.usage.reasoning.output_tokens',
  /**
   * 直方图（秒）：一次推理调用（chat）的耗时。属性：必填 `gen_ai.provider.name`，推荐
   * `gen_ai.response.model`，出错时 `error.type`。推理调用不记 `gen_ai.client.operation.duration`。
   */
  InferenceDuration: 'gen_ai.client.inference.duration',
  /** 直方图（秒）：流式推理调用从发出到收到第一块的耗时，只对流式调用记，属性同上。 */
  InferenceTimeToFirstChunk: 'gen_ai.client.inference.time_to_first_chunk',
} as const;

export const ErrorType = 'error.type';

/** 本项目的直方图（时长一律以秒为单位，UCUM 写作 `s`）。口径见运维“观测”。 */
export const Metric = {
  /** 宿主收到弹幕到回应它的发言第一句在 Stage 开始播出。 */
  DanmakuFirstAudio: 'bellis.danmaku.time_to_first_audio',
  /** 同上，再加上当时的呈现延迟 D：观众端声音出现在 OBS 输出里的估计。 */
  DanmakuFirstAudioPresented: 'bellis.danmaku.time_to_first_audio.presented',
  /** 一句的审核判定耗时（审核启用时）。 */
  ModerationDuration: 'bellis.moderation.check.duration',
  /** 仲裁发出合成到拿到第一个 PCM 帧。 */
  TtsFirstAudio: 'bellis.tts.time_to_first_audio',
  /** Stage 服务要求页面停止一句到页面回报已截断。 */
  StopToSilence: 'bellis.stage.stop_to_silence.duration',
  /** 执行许可实际续约时刻相对计划的滞后。 */
  LeaseRenewLag: 'bellis.lease.renew.lag',
  /** 宿主事件循环延迟：每个采样周期里的最大值。 */
  EventLoopDelay: 'bellis.host.event_loop.delay',
  /** 流式推理调用从发出到第一个正文块（不含思考内容；函数调用方式下为第一段函数参数）。 */
  LlmFirstOutput: 'bellis.llm.time_to_first_output',
} as const;
