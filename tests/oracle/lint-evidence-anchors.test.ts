/**
 * F20261012orcl: 断言证据锚点轻量规则（lint-evidence-anchors）——验证性断言无锚点 → warn。
 * warn 级起步（不阻断），测试锁检测逻辑本身（断言识别 / 锚点识别 / 章节提取）。
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error 真实现是 .mjs 脚本（无类型声明），import 纯函数
import { checkText, hasAnchor, isAssertionLine, findVerificationSections } from "../../scripts/lint-evidence-anchors.mjs";

describe("lint-evidence-anchors 检测逻辑", () => {
  it("验证性断言识别", () => {
    expect(isAssertionLine("全部通过。")).toBe(true);
    expect(isAssertionLine("测试 12/12 绿。")).toBe(true);
    expect(isAssertionLine("背景：三场事故。")).toBe(false);
  });

  it("锚点识别：file:line / 文档 ID / issue 号 / 命令 / 路径", () => {
    expect(hasAnchor("依据 scripts/check-oracle.mjs:10")).toBe(true);
    expect(hasAnchor("见 F20261012orcl 特性文档")).toBe(true);
    expect(hasAnchor("修复 #1430")).toBe(true);
    expect(hasAnchor("跑过 `node scripts/check-oracle.mjs`")).toBe(true);
    expect(hasAnchor("全部通过。")).toBe(false);
  });

  it("验证节有断言无锚点 → warn", () => {
    const warnings = checkText("## 验证\n全部通过。");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].heading).toBe("验证");
  });

  it("验证节有断言有锚点 → 不 warn", () => {
    const warnings = checkText(
      "## 验证\n全部通过（tests/oracle/check-oracle.test.ts 13/13 绿，输出见 `node scripts/check-oracle.mjs`）。",
    );
    expect(warnings).toHaveLength(0);
  });

  it("非验证节的断言 → 不 warn", () => {
    const warnings = checkText("## 背景\n全部通过。");
    expect(warnings).toHaveLength(0);
  });

  it("验证节无断言 → 不 warn", () => {
    const warnings = checkText("## 验证\n[验收阶段填写]");
    expect(warnings).toHaveLength(0);
  });

  it("章节提取层级感知：子标题内容仍归验证章", () => {
    const md = "## 验收结果\n### 测试结果\n全部通过。";
    const secs = findVerificationSections(md);
    // 「验收结果」入章；「测试结果」同为验证类标题接续；断言应被检出
    expect(checkText(md)).toHaveLength(1);
    expect(secs.length).toBeGreaterThanOrEqual(1);
  });
});
