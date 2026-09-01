import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isValidFid,
  FID_SUFFIX_SEGMENT,
  FID_PATTERN_SOURCE,
  FID_ANCHOR_REGEX,
  LEGACY_FID_IDS,
} from "@entities/document/fid-format";

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
    "F20260729imlo", // 存量真实：含 l+o（悬空 commit 501e9446 原形态，frontmatter 同 ID）
    "F20260827npmhvs", // 后缀 6 位（存量真实值）
    "F20260820val500", // 后缀 6 位含数字
    "F20260821mcp23", // 存量真实：字母+数字混排
    "F20260901234567890a", // 后缀 10 位（上界）
    "R20260817dshp", // R 前缀
  ])("边界长度 %s 合法", (id) => {
    expect(isValidFid(id)).toBe(true);
  });

  it.each([
    "F20260805im3", // 后缀 3 位（低于下界 4——非豁免存量均拒，见 LEGACY_FID_IDS）
    "F20260729im", // 后缀 2 位（文件名截断个例；frontmatter 与 commit 真实形态均为 4 位 imlo）
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

describe("真相源锁死元测试（#670 审视回修：堵死 hook 人工镜像漂移）", () => {
  // hook 是 shell 内嵌 node -e，无法 import ts 模块，与 fid-format.ts 之间仅靠
  // 注释互指。本元测试从 .githooks/commit-msg 源码中提取内联正则，断言其 ID
  // 段与 FID_SUFFIX_SEGMENT 拼接结果字符级一致——任何一侧单独改动都会在此
  // 变红，CI 即校验（#670 检视建议发现 4+5 合并处置）。
  const repoRoot = path.resolve(__dirname, "../../..");
  const hookSource = fs.readFileSync(path.join(repoRoot, ".githooks/commit-msg"), "utf-8");

  it("hook 内联 ID 正则与 fid-format.ts 导出段字符级一致", () => {
    // hook 源文件中 ID 段写法（fs 读到的原始字节，bash 双引号内 \\→\，node 字符串 \→正则\d）：
    //   const id = '(\\\\d{10}|\\\\d{8}[a-z0-9]{4,10})';（源文件每段 4 个反斜杠）
    const m = hookSource.match(/const id = '\((.+?)\)';/);
    expect(m).not.toBeNull();
    const hookIdSource = m![1];
    const expected = String.raw`\\\\d{10}|\\\\d{8}` + FID_SUFFIX_SEGMENT;
    expect(hookIdSource).toBe(expected);
  });

  it("hook 源码不再出现旧下限正则", () => {
    expect(hookSource).not.toMatch(/\[a-z0-9\]\{3,10\}/);
    expect(hookSource).not.toMatch(/3-10\s*位/);
  });

  it("FID_PATTERN_SOURCE 与真相源常量自洽", () => {
    expect(FID_PATTERN_SOURCE).toBe(`[FR]\\d{8}${FID_SUFFIX_SEGMENT}`);
    expect(FID_SUFFIX_SEGMENT).toBe("[a-z0-9]{4,10}");
  });

  it("存量豁免清单自身不与契约冲突：豁免项均不匹配新契约（否则豁免无意义）", () => {
    for (const id of LEGACY_FID_IDS) {
      expect(FID_ANCHOR_REGEX.test(id)).toBe(false);
      expect(isValidFid(id)).toBe(false); // 豁免是 validator 入库层的白名单，不是契约层放宽
    }
  });

  it("存量豁免清单是 F 前缀白名单：伪造同长度的 R 前缀 ID 不被豁免", () => {
    expect(LEGACY_FID_IDS.has("R20260731mmr")).toBe(false);
  });
});
