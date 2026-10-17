import { danmakuReplay, triage } from '@bellis/audience';
import { director, replayLlm } from '@bellis/director';
import { catalog } from '@bellis/kernel';
import { moderation, simModerationModel } from '@bellis/moderation';
import {
  localTts,
  scheduledAnnouncements,
  simTts,
  speechArbiter,
  speechReview,
} from '@bellis/speech';
import { obsControl, obsStagePage, simStagePage, stageService } from '@bellis/stage';
import { cloudTts } from '@bellis/tts-cloud';

/** 宿主内置的全部插件（本项目插件；第三方代码只能以 sidecar 接入）。 */
export const builtinPlugins = catalog(
  stageService,
  simStagePage,
  obsStagePage,
  obsControl,
  speechArbiter,
  speechReview,
  scheduledAnnouncements,
  simTts,
  cloudTts,
  localTts,
  moderation,
  simModerationModel,
  triage,
  danmakuReplay,
  director,
  replayLlm,
);
