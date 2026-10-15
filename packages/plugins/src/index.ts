import { danmakuReplay, triage } from '@bellis/audience';
import { director, replayLlm } from '@bellis/director';
import { catalog } from '@bellis/kernel';
import { moderation, simModerationModel } from '@bellis/moderation';
import { scheduledAnnouncements, simTts, speechArbiter } from '@bellis/speech';
import { simStagePage, stageService } from '@bellis/stage';

/** 宿主内置的全部插件（本项目插件；第三方代码只能以 sidecar 接入）。 */
export const builtinPlugins = catalog(
  stageService,
  simStagePage,
  speechArbiter,
  scheduledAnnouncements,
  simTts,
  moderation,
  simModerationModel,
  triage,
  danmakuReplay,
  director,
  replayLlm,
);
