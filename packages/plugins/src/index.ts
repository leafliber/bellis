import { danmakuReplay, triage, vote, voteLedger } from '@bellis/audience';
import { vtsAvatar } from '@bellis/avatar';
import { danmakuBilibili } from '@bellis/bilibili';
import { director, replayLlm } from '@bellis/director';
import { catalog } from '@bellis/kernel';
import { moderation, simModerationModel } from '@bellis/moderation';
import {
  localTts,
  scheduledAnnouncements,
  simTts,
  speechArbiter,
  speechReview,
  ttsRouter,
} from '@bellis/speech';
import { obsControl, obsStagePage, simStagePage, stageService, stageSync } from '@bellis/stage';
import { cloudTts } from '@bellis/tts-cloud';

/** 宿主内置的全部插件（本项目插件；第三方代码只能以 sidecar 接入）。 */
export const builtinPlugins = catalog(
  stageService,
  simStagePage,
  obsStagePage,
  obsControl,
  stageSync,
  speechArbiter,
  speechReview,
  scheduledAnnouncements,
  simTts,
  cloudTts,
  localTts,
  ttsRouter,
  moderation,
  simModerationModel,
  triage,
  danmakuReplay,
  danmakuBilibili,
  vote,
  director,
  replayLlm,
  vtsAvatar,
);

/**
 * 内置插件用到的投影：宿主（与仿真）打开状态存储时注册，重启时从事件重建（见状态存储“表”）。
 * 插件经安全核门面的 `view` 读取。
 */
export const builtinProjections = [voteLedger] as const;
