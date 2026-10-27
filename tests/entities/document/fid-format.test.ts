import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isValidFid,
  FID_SUFFIX_SEGMENT,
  FID_PATTERN_SOURCE,
  FID_ANCHOR_REGEX,
  FID_READ_ANCHOR_REGEX,
  LEGACY_FID_IDS,
} from "@entities/document/fid-format";

describe("FID 形态契约（#667 + F20261027-fidr）", () => {
  it.each([
    "F20260826o46s", "F20260826scl1", "F20260827mtbl", "F20260826dpao", "F20260825evgl",
    "F20260729imlo", "F20260827npmhvs", "F20260820val500", "F20260821mcp23",
    "R20260817dshp",
  ])("字母开头兼容 ID %s 合法", (id) => {
    expect(isValidFid(id)).toBe(true);
  });

  it.each([
    "F20261027-x59c4",
    "F20261027-59c4",
    "R20261027-abcd123456",
    "F20261027-a123456789",
  ])("显式日期边界 %s 合法", (id) => {
    expect(isValidFid(id)).toBe(true);
  });

  it.each([
    "F20260805im3", "F20260729im", "F20260901234567890123",
    "f20260805abcd", "F2026085abcd", "X20260805abcd", "F20260805ABCD",
    "F20260805ab_d", "F2026102759c4", "F20260805-ab", "F20260805-abcdefghijk",
    "F2026-0805abcd", "F-20260805abcd", "F20260901234567890a", "",
  ])("非法或不可读形态 %s 新写拒绝", (id) => {
    expect(isValidFid(id)).toBe(false);
  });
});

describe("宽读严写：历史识别不等于新写许可", () => {
  it.each([...LEGACY_FID_IDS].filter(id => id !== "F20260731mmr"))(
    "数字直连历史 ID %s 仅识别、不验收", (id) => {
      expect(isValidFid(id)).toBe(false);
      expect(FID_READ_ANCHOR_REGEX.test(id)).toBe(true);
    },
  );

  it("3 位 mmr 只保留既有 validator 白名单，read 行为不扩张", () => {
    expect(FID_READ_ANCHOR_REGEX.test("F20260731mmr")).toBe(false);
  });
});

describe("真相源锁死元测试（hook/CI 人工镜像漂移）", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const hookSource = fs.readFileSync(path.join(repoRoot, ".githooks/commit-msg"), "utf-8");

  it("hook 内联 ID 正则与 fid-format.ts 严格段字符级一致", () => {
    const m = hookSource.match(/const id = '\((.+?)\)';/);
    expect(m).not.toBeNull();
    const expected = String.raw`\\\\d{8}` + FID_SUFFIX_SEGMENT;
    expect(m![1]).toBe(expected);
  });

  it("CI 调用可单测的零构建依赖标题脚本，严格段与真相源锁镜像", () => {
    const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf-8");
    expect(ci).toContain('node scripts/check-pr-title.cjs "$PR_TITLE"');
    const checker = fs.readFileSync(path.join(repoRoot, "scripts/check-pr-title.cjs"), "utf-8");
    expect(checker).toContain('String.raw`(?:[a-z][a-z0-9]{3,9}|-[a-z0-9]{4,10})`');
    expect(checker).toContain('\\d{8}${FID_STRICT_SEGMENT}');
    expect(checker).not.toContain("../dist/");
  });

  it("hook 源码不再出现旧 10 位数字或下限正则", () => {
    expect(hookSource).not.toMatch(/\\d\{10\}/);
    expect(hookSource).not.toMatch(/\[a-z0-9\]\{3,10\}/);
    expect(hookSource).not.toMatch(/3-10\s*位/);
  });

  it("FID_PATTERN_SOURCE 与真相源常量自洽", () => {
    expect(FID_PATTERN_SOURCE).toBe(`[FR]\\d{8}${FID_SUFFIX_SEGMENT}`);
    expect(FID_SUFFIX_SEGMENT).toBe("(?:[a-z][a-z0-9]{3,9}|-[a-z0-9]{4,10})");
  });

  it("存量豁免均不匹配新契约（豁免不是验收放宽）", () => {
    for (const id of LEGACY_FID_IDS) {
      expect(FID_ANCHOR_REGEX.test(id)).toBe(false);
      expect(isValidFid(id)).toBe(false);
    }
  });

  it("存量豁免清单是 F 前缀白名单", () => {
    expect(LEGACY_FID_IDS.has("R20260731mmr")).toBe(false);
  });
});
