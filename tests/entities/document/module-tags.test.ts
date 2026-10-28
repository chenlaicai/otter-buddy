import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MODULE_RECOMMENDED_TAG_NAMES,
  MODULE_BANNED_TAG_NAMES,
  MODULE_TAG_PATTERN,
  isValidModuleTagFormat,
  formatRecommendedTags,
} from "@entities/document/module-tags";

/**
 * F20260924mseu 元测试：锁死 module-tags.ts 单一真相源 ↔ commit-msg hook ↔
 * CI 标题检查脚本（F20261027fidrx 从 ci.yml 抽出）人工镜像的字符级一致。
 */

const repoRoot = path.resolve(__dirname, "../../..");

/** 从 hook 源码中提取内联镜像清单（数组字面量原样匹配） */
function extractHookList(varName: string): string[] {
  const hookSrc = fs.readFileSync(path.join(repoRoot, ".githooks/commit-msg"), "utf-8");
  const m = hookSrc.match(new RegExp(`const ${varName} = \\[([^\\]]*)\\];`));
  if (!m) throw new Error(`hook 中未找到 ${varName} 数组`);
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
}

function extractCiRecommended(): string[] {
  const ciSrc = fs.readFileSync(path.join(repoRoot, "scripts/check-pr-title.cjs"), "utf-8");
  const line = ciSrc.split("\n").find((l) => l.includes("改为有边界的子系统名"));
  const m = line?.match(/如 ([a-z/]+)。/);
  if (!m) throw new Error("CI 标题检查脚本中未找到推荐词清单");
  return m[1].split("/");
}

function extractCiBanned(): string[] {
  const ciSrc = fs.readFileSync(path.join(repoRoot, "scripts/check-pr-title.cjs"), "utf-8");
  const match = ciSrc.match(/const MODULE_BANNED = new Set\(\[(.*?)\]\)/);
  if (!match) throw new Error("CI 标题检查脚本中未找到行为黑名单");
  return match[1].split(",").map(v => v.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

describe("模块位词表契约（F20260924mseu 单一真相源）", () => {
  it("推荐词表 ↔ commit-msg hook 内联镜像字符级一致", () => {
    expect(extractHookList("moduleRecommended")).toEqual([...MODULE_RECOMMENDED_TAG_NAMES]);
  });

  it("黑名单 ↔ commit-msg hook 内联镜像字符级一致", () => {
    expect(extractHookList("moduleBanned")).toEqual([...MODULE_BANNED_TAG_NAMES]);
  });

  it("推荐词表 ↔ CI 标题检查脚本提示清单一致", () => {
    expect(extractCiRecommended()).toEqual([...MODULE_RECOMMENDED_TAG_NAMES]);
  });

  it("黑名单 ↔ CI 标题检查脚本行为名单一致", () => {
    expect(extractCiBanned()).toEqual([...MODULE_BANNED_TAG_NAMES]);
  });

  it("推荐词与黑名单无交集", () => {
    const banned = new Set(MODULE_BANNED_TAG_NAMES);
    for (const tag of MODULE_RECOMMENDED_TAG_NAMES) {
      expect(banned.has(tag)).toBe(false);
    }
  });

  it("全部词符合形态契约（小写字母、无连字符）", () => {
    for (const tag of [...MODULE_RECOMMENDED_TAG_NAMES, ...MODULE_BANNED_TAG_NAMES]) {
      expect(isValidModuleTagFormat(tag)).toBe(true);
      expect(tag).toMatch(new RegExp(`^${MODULE_TAG_PATTERN}$`));
    }
  });

  it("形态校验拒绝非法输入", () => {
    expect(isValidModuleTagFormat("agent-runtime")).toBe(false); // 连字符（存量 convention 文档曾示范此非法形态）
    expect(isValidModuleTagFormat("Agent")).toBe(false); // 大写
    expect(isValidModuleTagFormat("")).toBe(false);
  });

  it("历史碎裂同义词不回潮推荐表", () => {
    // 特性文档背景节点名的碎裂同义词：收编后的唯一形态已在表，旧形态永不得回流
    const deprecatedSynonyms = ["skills", "weixin", "feishu", "rhi", "healing", "toolchain", "scripts", "deps", "readme", "db"];
    for (const tag of deprecatedSynonyms) {
      expect(MODULE_RECOMMENDED_TAG_NAMES).not.toContain(tag);
    }
  });

  it("formatRecommendedTags 每行一个词", () => {
    const lines = formatRecommendedTags().split("\n");
    expect(lines).toHaveLength(MODULE_RECOMMENDED_TAG_NAMES.length);
    for (const tag of MODULE_RECOMMENDED_TAG_NAMES) {
      expect(lines.some((l) => l.startsWith(`${tag} — `))).toBe(true);
    }
  });

  it("commit-convention.md 指向单一真相源（不再自维护示例清单）", () => {
    const doc = fs.readFileSync(
      path.join(repoRoot, ".pi/skills/code-implementation/references/commit-convention.md"),
      "utf-8",
    );
    expect(doc).toContain("module-tags.ts");
    expect(doc).not.toContain("agent-runtime"); // 非法示例已清除
  });

  it("CONTRIBUTING.md 指向单一真相源", () => {
    const doc = fs.readFileSync(path.join(repoRoot, "CONTRIBUTING.md"), "utf-8");
    expect(doc).toContain("module-tags.ts");
  });
});
