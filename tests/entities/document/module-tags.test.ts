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
 * F20260924mseu 元测试：锁死 module-tags.ts 单一真相源 ↔ commit-msg hook ↔ ci.yml
 * 三处人工内联镜像的字符级一致。任何一侧单独改动立即变红（#667/#670 同款先例）。
 */

const repoRoot = path.resolve(__dirname, "../../..");

/** 从 hook 源码中提取内联镜像清单（数组字面量原样匹配） */
function extractHookList(varName: string): string[] {
  const hookSrc = fs.readFileSync(path.join(repoRoot, ".githooks/commit-msg"), "utf-8");
  const m = hookSrc.match(new RegExp(`const ${varName} = \\[([^\\]]*)\\];`));
  if (!m) throw new Error(`hook 中未找到 ${varName} 数组`);
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
}

/** 从 ci.yml 报错文案中提取推荐词清单（推荐 X/Y/Z；格式） */
function extractCiRecommended(): string[] {
  const ciSrc = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf-8");
  const m = ciSrc.match(/推荐 ([a-z/]+)；清单外开放/);
  if (!m) throw new Error("ci.yml 中未找到推荐词清单");
  return m[1].split("/");
}

/** 从 ci.yml 报错文案中提取黑名单（X/Y/Z 禁用，F20260924mseu） */
function extractCiBanned(): string[] {
  const ciSrc = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf-8");
  const m = ciSrc.match(/([a-z/]+) 禁用，F20260924mseu/);
  if (!m) throw new Error("ci.yml 中未找到黑名单清单");
  return m[1].split("/");
}

describe("模块位词表契约（F20260924mseu 单一真相源）", () => {
  it("推荐词表 ↔ commit-msg hook 内联镜像字符级一致", () => {
    expect(extractHookList("moduleRecommended")).toEqual([...MODULE_RECOMMENDED_TAG_NAMES]);
  });

  it("黑名单 ↔ commit-msg hook 内联镜像字符级一致", () => {
    expect(extractHookList("moduleBanned")).toEqual([...MODULE_BANNED_TAG_NAMES]);
  });

  it("推荐词表 ↔ ci.yml 报错文案一致", () => {
    expect(extractCiRecommended()).toEqual([...MODULE_RECOMMENDED_TAG_NAMES]);
  });

  it("黑名单 ↔ ci.yml 报错文案一致", () => {
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
