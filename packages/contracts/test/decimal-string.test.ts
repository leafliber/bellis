import { describe, expect, it } from "vitest";
import {
  DecimalStringSchema,
  MAX_DECIMAL_STRING_LENGTH,
  formatDecimalString,
  parseDecimalString,
} from "../src/common/decimal-string.js";

describe("DecimalStringSchema", () => {
  it.each(["0", "1", "9", "10", "12345678901234567890", "18446744073709551615"])(
    "accepts canonical decimal string %s",
    (value) => {
      expect(DecimalStringSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    ["-1"],
    ["+1"],
    ["1.5"],
    [".5"],
    ["1e3"],
    ["0x10"],
    ["01"],
    ["007"],
    [" 1"],
    ["1 "],
    ["１"],
    [""],
    ["9".repeat(MAX_DECIMAL_STRING_LENGTH + 1)],
  ])("rejects non-canonical input %s", (value) => {
    expect(DecimalStringSchema.safeParse(value).success).toBe(false);
  });

  it("accepts the maximum 30-digit string and rejects 31 digits", () => {
    expect(DecimalStringSchema.safeParse("9".repeat(30)).success).toBe(true);
    expect(DecimalStringSchema.safeParse("1" + "0".repeat(30)).success).toBe(false);
  });
});

describe("parseDecimalString / formatDecimalString", () => {
  it("round-trips any non-negative bigint without precision loss", () => {
    for (const value of [0n, 1n, 9007199254740993n, 18446744073709551615n, 10n ** 29n]) {
      expect(parseDecimalString(formatDecimalString(value))).toBe(value);
    }
  });

  it("round-trips any canonical string input", () => {
    for (const value of ["0", "42", "9007199254740993", "18446744073709551615"]) {
      expect(formatDecimalString(parseDecimalString(value))).toBe(value);
    }
  });

  it("parseDecimalString rejects invalid input", () => {
    for (const value of ["-1", "+1", "1.5", "1e3", "01", "", " ", "0x1", "١٢"]) {
      expect(() => parseDecimalString(value)).toThrow(RangeError);
    }
  });

  it("formatDecimalString rejects negative values", () => {
    expect(() => formatDecimalString(-1n)).toThrow(RangeError);
  });

  it("formatDecimalString rejects values beyond the 30-digit schema limit", () => {
    expect(formatDecimalString(10n ** 29n)).toBe("1" + "0".repeat(29));
    expect(() => formatDecimalString(10n ** 30n)).toThrow(RangeError);
    // 编码结果必须能被对应 Schema 接受（恒等映射保证）。
    expect(DecimalStringSchema.safeParse(formatDecimalString(10n ** 29n)).success).toBe(true);
  });
});
