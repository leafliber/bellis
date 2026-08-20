import { z } from "zod";

/**
 * 十进制字符串在 JSON/WS 边界上承载 bigint（微秒时间、序号、水位），
 * 是唯一合法形式；裸 bigint 无法被 JSON.stringify 序列化（ADR 0001）。
 *
 * 仅接受规范形式：非负、无前导零（单独的 "0" 除外）、无符号、无小数点、
 * 无指数、无空白与非 ASCII 数字，长度不超过 MAX_DECIMAL_STRING_LENGTH。
 * Runtime 产生的值永远是规范形式；该约束同时保证
 * formatDecimalString 与 parseDecimalString 互为恒等映射。
 */

/** 合法十进制字符串的最大位数。30 位（< 10^30 微秒 ≈ 3×10^16 年）远超任何单调时钟与序号需求。 */
export const MAX_DECIMAL_STRING_LENGTH = 30;

const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,29})$/;

/** 非负十进制数字字符串 Schema。 */
export const DecimalStringSchema = z.string().regex(DECIMAL_PATTERN, {
  message: `must be a canonical non-negative decimal string of at most ${MAX_DECIMAL_STRING_LENGTH} digits`,
});

function describe(value: string): string {
  const shown = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return JSON.stringify(shown);
}

/**
 * 把已通过 Schema 校验的非负十进制字符串无损转换为 bigint。
 * 负数、小数、指数、前导符号、前导零、超限输入都会抛出 RangeError。
 */
export function parseDecimalString(value: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new RangeError(`invalid decimal string: ${describe(value)}`);
  }
  return BigInt(value);
}

/** 把非负 bigint 编码为规范十进制字符串；负数与超上限值直接拒绝。 */
export function formatDecimalString(value: bigint): string {
  if (value < 0n) {
    throw new RangeError("negative values cannot be encoded as decimal strings");
  }
  const formatted = value.toString(10);
  if (formatted.length > MAX_DECIMAL_STRING_LENGTH) {
    throw new RangeError(
      `value exceeds the ${MAX_DECIMAL_STRING_LENGTH}-digit decimal string limit`,
    );
  }
  return formatted;
}

/**
 * 供跨字段 refine 使用的安全比较：任一输入非法时返回 false
 * （具体错误由字段级校验报告），保证 refine 回调绝不抛出。
 * zod 4 会在字段校验失败后仍执行 refine，因此这是必需的防护。
 */
export function decimalStringLte(left: string, right: string): boolean {
  try {
    return parseDecimalString(left) <= parseDecimalString(right);
  } catch {
    return false;
  }
}
