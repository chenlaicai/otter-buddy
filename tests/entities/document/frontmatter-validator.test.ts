/**
 * F20260827spcs: frontmatter validator 新增规则测试（#470 / #455）
 *
 * 覆盖：title 可读性（纯 slug 报 warn）、文件名 slug 后缀（裸 ID 报 warn）、
 * status 枚举 active 补录（不再误报）。规则实现在单一真相源
 * src/entities/document/frontmatter-validator.ts，本测试直接 import 真实现。
 */
import { describe, it, expect } from "vitest";
import {
  validateFeatureFrontmatter,
  validateTitleReadability,
  validateFilenameSlug,
} from "../../../src/entities/document/frontmatter-validator";
import { isKnownFeatureStatus } from "../../../src/entities/document/known-values";

const BASE_FM = {
  id: "F20260827test",
  title: "特性文档 lint 校验增强",
  summary: "补齐 status 枚举与 title 可读性校验",
  status: "development",
  change_type: "prompt",
};

describe("validateFeatureFrontmatter: 存量豁免清单（#667 LEGACY_FID_IDS）", () => {
  it("F20260731mmr（3 位后缀真存量，DB 同 id）放行不报 Invalid", () => {
    const r = validateFeatureFrontmatter(
      { ...BASE_FM, id: "F20260731mmr" },
      "docs/features/2026/07/31/F20260731-multi-model-routing.md"
    );
    expect(r.errors.some((e) => e.includes("Invalid feature ID"))).toBe(false);
  });

  it("同形态新 ID 不被豁免（豁免是白名单不是放宽）：F20260801xyz 仍报 Invalid", () => {
    const r = validateFeatureFrontmatter(
      { ...BASE_FM, id: "F20260801xyz" },
      "docs/features/2026/08/01/F20260801-xyz.md"
    );
    expect(r.errors.some((e) => e.includes("Invalid feature ID"))).toBe(true);
  });
});

describe("validateFeatureFrontmatter: title 可读性（#470）", () => {
  it("纯 slug title（无 CJK 无空格）报 warning", () => {
    const r = validateFeatureFrontmatter(
      { ...BASE_FM, title: "stock-cli-pr1-data-bridge" },
      "docs/features/2026/08/27/F20260827test-stock-cli-pr1-data-bridge.md"
    );
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes("Title looks like a slug"))).toBe(true);
  });

  it("中文 title 不报警告", () => {
    const r = validateFeatureFrontmatter(
      { ...BASE_FM, title: "commit-msg 钩子类型白名单与 commit-convention.md 对齐" },
      "docs/features/2026/08/27/F20260827test-hook-whitelist.md"
    );
    expect(r.warnings.some((w) => w.includes("Title looks like a slug"))).toBe(false);
  });

  it("英文多词 title（含空格）不报警告", () => {
    const r = validateFeatureFrontmatter(
      { ...BASE_FM, title: "Add force-with-lease carve-out to R1" },
      "docs/features/2026/08/27/F20260827test-r1-carveout.md"
    );
    expect(r.warnings.some((w) => w.includes("Title looks like a slug"))).toBe(false);
  });
});

describe("validateFeatureFrontmatter: 文件名 slug 后缀（#470 评论必查项）", () => {
  it("裸 ID 文件名（无 slug 后缀）报 warning", () => {
    const r = validateFeatureFrontmatter(BASE_FM, "docs/features/2026/08/27/F20260827test.md");
    expect(r.warnings.some((w) => w.includes("missing slug suffix"))).toBe(true);
  });

  it("带 slug 后缀的文件名不报警告", () => {
    const r = validateFeatureFrontmatter(
      BASE_FM,
      "docs/features/2026/08/27/F20260827test-lint-docs-enhance.md"
    );
    expect(r.warnings.some((w) => w.includes("missing slug suffix"))).toBe(false);
  });
});

describe("status 枚举 active 补录（#455）", () => {
  it("status: active 是已知值", () => {
    expect(isKnownFeatureStatus("active")).toBe(true);
  });

  it("status: in-progress 仍报 Unknown warning（#470 原始案例）", () => {
    const r = validateFeatureFrontmatter(
      { ...BASE_FM, status: "in-progress" },
      "docs/features/2026/08/27/F20260827test-lint-docs-enhance.md"
    );
    expect(r.warnings.some((w) => w.includes("Unknown feature status: in-progress"))).toBe(true);
  });
});

describe("纯函数导出（供 lint 脚本与测试直接消费）", () => {
  it("validateTitleReadability: 空串与空白 title 不报警", () => {
    const w: string[] = [];
    validateTitleReadability("   ", w);
    expect(w).toHaveLength(0);
  });

  it("validateFilenameSlug: 非 F 前缀文件不报警", () => {
    const w: string[] = [];
    validateFilenameSlug("docs/research/2026/08/27/R20260827test.md", w);
    expect(w).toHaveLength(0);
  });
});
