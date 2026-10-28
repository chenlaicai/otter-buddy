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

describe("FID 新写契约（F20261027fidrx：固定 5 个小写字母）", () => {
  it.each([
    "F20261027abcde", "R20261027fiver", "F20261027lorem",
    "F20261027ilooo", // 只限字母，不恢复 0/1/l/o 排除
  ])("合法：%s", (id) => {
    expect(isValidFid(id)).toBe(true);
  });

  it.each([
    "F20261027abcd", // 4 位，即使全字母也不符合新写
    "F20261027abcdef", // 6 位
    "F20261027x59c4", // 字母开头但含数字
    "F2026102759c4", // 数字直连
    "F20261027-abcde", // 中划线新写明确否决
    "F20261027-x59c4",
    "F20261027ABCDE",
    "f20261027abcde",
    "F2026085abcde",
    "F20260805ab_de",
    "",
  ])("拒绝：%s", (id) => {
    expect(isValidFid(id)).toBe(false);
  });
});

describe("宽读严写：历史识别不等于新写许可", () => {
  it.each([
    "F2026090326c5", "F202609048840", "F2026090211v4", "F202609025itn", "F202608119glo",
    "F20260825evgl", "F20260827npmhvs", "F20261015selfheal", "F20261027-59c4",
  ])("历史 ID %s 仅识别、不验收", (id) => {
    expect(isValidFid(id)).toBe(false);
    expect(FID_READ_ANCHOR_REGEX.test(id)).toBe(true);
  });

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

  it("CI 调用零构建依赖标题脚本，严格段与真相源锁镜像", () => {
    const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf-8");
    expect(ci).toContain('node scripts/check-pr-title.cjs "$PR_TITLE"');
    const checker = fs.readFileSync(path.join(repoRoot, "scripts/check-pr-title.cjs"), "utf-8");
    expect(checker).toContain('String.raw`[a-z]{5}`');
    expect(checker).toContain('\\d{8}${FID_STRICT_SEGMENT}');
    expect(checker).not.toContain("../dist/");
  });

  it("hook 源码不再出现旧可变长度或数字 ID 分支", () => {
    expect(hookSource).not.toMatch(/\\d\{10\}/);
    expect(hookSource).not.toMatch(/\[a-z0-9\]\{3,10\}/);
    expect(hookSource).not.toMatch(/3-10\s*位/);
  });

  it("FID_PATTERN_SOURCE 与真相源常量自洽", () => {
    expect(FID_PATTERN_SOURCE).toBe(`[FR]\\d{8}${FID_SUFFIX_SEGMENT}`);
    expect(FID_SUFFIX_SEGMENT).toBe("[a-z]{5}");
  });

  it("存量代码豁免均不匹配新契约（历史主体由 read 契约承载）", () => {
    for (const id of LEGACY_FID_IDS) {
      expect(FID_ANCHOR_REGEX.test(id)).toBe(false);
      expect(isValidFid(id)).toBe(false);
    }
  });
});
