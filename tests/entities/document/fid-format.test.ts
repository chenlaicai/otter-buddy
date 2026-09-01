import { describe, it, expect } from "vitest";
import { isValidFid } from "@entities/document/fid-format";

describe("FID 形态契约（#667 单一真相源）", () => {
  // 存量真实 ID 回归：含 0/1/l/o 的后缀曾于 8/25-9/01 期间被 commit-parser
  // 旧字母表 [a-kmnp-z][2-9a-kmnp-z] 漏判（实测 5 个，issue #667）
  it.each([
    "F20260826o46s", // 含 o
    "F20260826scl1", // 含 1
    "F20260827mtbl", // 含 l
    "F20260826dpao", // 含 o
    "F20260825evgl", // 含 l
  ])("存量 ID %s 合法（旧字母表漏判回归）", (id) => {
    expect(isValidFid(id)).toBe(true);
  });

  it.each([
    "F20260805im3", // 后缀 3 位（下界，兼容历史）
    "F20260827npmhvs", // 后缀 6 位（存量真实值）
    "F20260820val500", // 后缀 6 位含数字
    "F20260821mcp23", // 存量真实：字母+数字混排
    "F20260901234567890a", // 后缀 10 位（上界）
    "R20260817dshp", // R 前缀
  ])("边界长度 %s 合法", (id) => {
    expect(isValidFid(id)).toBe(true);
  });

  it.each([
    "F20260805im", // 后缀 2 位（低于下界）
    "F20260901234567890123", // 后缀 12 位（超上界）
    "f20260805abcd", // 小写前缀
    "F2026085abcd", // 日期 7 位
    "X20260805abcd", // 非 F/R 前缀
    "F20260805ABCD", // 大写后缀
    "F20260805ab_d", // 下划线
    "F-20260805abcd", // 前缀后连字符
    "", // 空串
  ])("非法形态 %s 拒绝", (id) => {
    expect(isValidFid(id)).toBe(false);
  });
});
