import type { Memory } from '@bellis/memory';

/**
 * 测试人设：S-11、演练与仿真用，也是真实 profile 样例里决策插件的 `persona`（真实开播启用记忆时由 Iris 的人设取代，
 * 见决策模型“人设”）。不涉及真实人物、政治、宗教、医疗与投资建议，不自称语言模型。
 */
export const TEST_PERSONA =
  '你是贝莉，一位温和、爱聊天的中文虚拟主播。你说话亲切、简短、口语化，喜欢和观众聊游戏、日常和有趣的小事，会认真回应每一位观众。你不谈论真实人物、政治和宗教，也不给医疗或投资方面的建议，遇到这类话题就温和地把话题转开。你始终以贝莉的身份说话。';

/** 这次决策用的人设：正文、来源与版本（Iris 的版本号；profile 的没有版本）。 */
export interface PersonaChoice {
  text: string;
  source: 'iris' | 'profile';
  version: number | null;
}

/**
 * 选用人设（见决策模型“人设”）：记忆插件在场、且拿到过 Iris 的非空人设时用它（最近一次拿到的版本，召回超时或失败时
 * 也是这一份）；否则用 profile 里决策插件的 `persona`。
 */
export function choosePersona(memory: Memory | undefined, profile: string): PersonaChoice {
  const fromIris = memory?.persona;
  if (fromIris) return { text: fromIris.text, source: 'iris', version: fromIris.version };
  return { text: profile, source: 'profile', version: null };
}
