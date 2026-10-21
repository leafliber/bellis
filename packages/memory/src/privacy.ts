/**
 * 隐私网关：写入 Iris 之前、召回结果进入决策上下文之前，用可配置的确定性规则拦下含个人敏感信息的文本
 * （所在地、健康、家人、联系方式、身份信息）。命中任何一条就整条不写、不用，不做改写或打码。
 *
 * 匹配前先规范化：NFKC（全角数字与字母变半角）、去掉不可见字符与全部空白、转小写；规则写在规范化后的文本上。
 *
 * 局限（规则只是关键词与格式，不理解语义）：
 * - 换个说法就漏：“我们这边下雪了”“刚从医院回来”这类不含规则里的词的说法拦不住；谐音、拼音、缩写、emoji、
 *   拆字与故意插入符号也拦不住；同一件事拆成几条弹幕分别说，每条单看都不命中。
 * - 也会多拦：游戏剧情、角色扮演、玩笑里的“我妈”“住院”照样拦下；角色自己的发言同样过这道网关。
 * - 只看文本：图片、语音不经过这里（P2 不写媒体）。
 * 这道网关不依赖 Iris 的学习规则，但也不能代替它：Iris 学到什么仍由它自己的模型决定（见合规“Iris 外发”）。
 */

export interface PrivacyRule {
  /** 类别名，只写进事实与日志（例如 `location`），不含被拦下的内容。 */
  category: string;
  /** 正则（Unicode 模式），匹配规范化后的文本。 */
  pattern: string;
}

/** 缺省规则。profile 可以整体替换（`privacy.rules`），空数组表示不过滤。 */
export const DEFAULT_PRIVACY_RULES: readonly PrivacyRule[] = [
  // 所在地：自报住址、学校或单位所在地。
  { category: 'location', pattern: '(?:老家|家乡|坐标|现居|住址|家住|住在|住的地方|定位在)' },
  {
    category: 'location',
    pattern:
      '我(?:家)?(?:在|是)[^,.!?，。！？]{0,8}(?:省|市|区|县|镇|乡|村|街|路|小区|大学|学院|中学|小学|高中|初中)',
  },
  // 健康：疾病、就医、用药、怀孕等。
  {
    category: 'health',
    pattern:
      '(?:生病|病了|住院|出院|手术|确诊|诊断|化疗|癌|肿瘤|抑郁|焦虑症|精神病|吃药|服药|怀孕|流产|残疾|病历|过敏|发烧|感冒|新冠|阳了|hiv|艾滋)',
  },
  // 家人：自己的家庭成员与伴侣。
  {
    category: 'family',
    pattern:
      '(?:我|俺|咱)(?:的)?(?:爸|妈|爹|娘|父亲|母亲|爷爷|奶奶|姥姥|姥爷|外公|外婆|老公|老婆|丈夫|妻子|媳妇|儿子|女儿|孩子|哥|姐|弟|妹|家人|家里人|对象|男朋友|女朋友|男友|女友)',
  },
  // 联系方式：手机号、邮箱、QQ 与微信号。
  { category: 'contact', pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)' },
  { category: 'contact', pattern: '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}' },
  { category: 'contact', pattern: '(?:qq|扣扣|微信|vx|wx|v信|wechat)号?[:：]?[a-z0-9_-]{5,}' },
  // 身份信息：证件号、真实姓名、年龄。
  { category: 'identity', pattern: '(?<!\\d)\\d{17}[\\dx](?!\\d)' },
  { category: 'identity', pattern: '(?:身份证|银行卡|卡号|真名|真实姓名|本名|学号|工号)' },
  { category: 'identity', pattern: '我(?:今年)?\\d{1,2}岁' },
];

/** 控制字符、格式字符（零宽、双向控制等）、私用区、代理项。 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;

/** 召回的记忆进上下文前的整理：去掉不可见字符、合并空白、截到 `max` 个码点；不改写其余字符。 */
export function cleanText(text: string, max: number): string {
  const visible = text.replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
  return [...visible].slice(0, max).join('');
}

/** 规则匹配用的规范化：NFKC、去掉不可见字符与全部空白、转小写。 */
export function normalizeForRules(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/gu, '').toLowerCase();
}

export type PrivacyVerdict = { ok: true } | { ok: false; categories: string[] };

export class PrivacyGateway {
  readonly #rules: ReadonlyArray<{ category: string; regex: RegExp }>;

  /** 编译规则；有不合法的正则时抛错，说明是第几条。 */
  constructor(rules: readonly PrivacyRule[]) {
    this.#rules = rules.map((rule, index) => {
      try {
        return { category: rule.category, regex: new RegExp(rule.pattern, 'u') };
      } catch (error) {
        throw new Error(
          `隐私规则第 ${index + 1} 条（${rule.category}）不是合法的正则：${(error as Error).message}`,
        );
      }
    });
  }

  get size(): number {
    return this.#rules.length;
  }

  /** 命中的类别（去重、按规则顺序）；都不命中时通过。 */
  check(text: string): PrivacyVerdict {
    const normalized = normalizeForRules(text);
    const categories: string[] = [];
    for (const { category, regex } of this.#rules) {
      if (regex.test(normalized) && !categories.includes(category)) categories.push(category);
    }
    return categories.length === 0 ? { ok: true } : { ok: false, categories };
  }
}
