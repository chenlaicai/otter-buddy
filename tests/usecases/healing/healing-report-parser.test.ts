import { describe, it, expect } from "vitest";
import { parseHealingReport, stripHealingReport } from "@usecases/healing/healing-report-parser";

describe("parseHealingReport", () => {
  // ── 基本功能 ──

  it("returns no issues for [no_issue]", () => {
    const result = parseHealingReport("Hello world<healing>[no_issue]</healing>");
    expect(result.hasIssues).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it("returns no issues when no healing tag present", () => {
    const result = parseHealingReport("Just a normal message");
    expect(result.hasIssues).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it("parses single issue correctly", () => {
    const body = `Reply text
<healing>
[issues]
- type: tool_failure
  severity: high
  description: search_memory returned empty results
  suggestion: check embedding service status
[/issues]
</healing>`;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe("tool_failure");
    expect(result.issues[0].severity).toBe("high");
    expect(result.issues[0].description).toBe("search_memory returned empty results");
    expect(result.issues[0].suggestion).toBe("check embedding service status");
  });

  it("parses multiple issues", () => {
    const body = `<healing>[issues]
- type: tool_failure
  severity: high
  description: tool crashed
  suggestion: add retry
- type: missing_context
  severity: medium
  description: no session summary
  suggestion: check handoff
[/issues]</healing>`;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(true);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].type).toBe("tool_failure");
    expect(result.issues[1].type).toBe("missing_context");
  });

  // ── LLM 偏差鲁棒性 ──

  it("handles case-insensitive tags", () => {
    const body = "<Healing>[no_issue]</Healing>";
    expect(parseHealingReport(body).hasIssues).toBe(false);
  });

  it("handles markdown-escaped tags", () => {
    const body = "\\<healing\\>[no_issue]\\</healing\\>";
    expect(parseHealingReport(body).hasIssues).toBe(false);
  });

  it("does NOT treat backtick-wrapped tags as a report (正文引用不触发, F20260904hstr)", () => {
    // 反引号包裹的标签是正文引用（行内代码），不是报告块。
    // 旧版会将其还原为裸标签参与匹配，导致正文提及协议即被误吞。
    const body = "`<healing>`[no_issue]`</healing>`";
    expect(parseHealingReport(body).hasIssues).toBe(false);
  });

  // ── 正文引用防护（F20260904hstr 现场：正文提及标签名被整段吞） ──

  it("正文裸写标签字样（无标记）不触发解析", () => {
    const body = "协议说明：<healing> 块让海獭自报问题，旧正则会从这吞到文末";
    expect(parseHealingReport(body).hasIssues).toBe(false);
  });

  it("正文引用 + 文末真报告块：只解析真块", () => {
    const body = `正文提及 <healing> 字样，甚至代码示例 \\<healing\\> 都不算
中间还有内容
<healing>[issues]
- type: tool_failure
  severity: high
  description: real issue
  suggestion: fix
[/issues]</healing>`;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].description).toBe("real issue");
  });

  it("残缺报告块（缺 [/issues] 闭合）不解析", () => {
    const body = `<healing>[issues]
- type: tool_failure
  severity: high
  description: truncated
  suggestion: fix
</healing>`;
    expect(parseHealingReport(body).hasIssues).toBe(false);
  });

  it("handles missing closing tag", () => {
    const body = "<healing>[no_issue]";
    expect(parseHealingReport(body).hasIssues).toBe(false);
  });

  it("falls back to 'other' for unknown type", () => {
    const body = `<healing>[issues]
- type: unknown_type
  severity: low
  description: something
  suggestion: fix it
[/issues]</healing>`;
    const result = parseHealingReport(body);
    expect(result.issues[0].type).toBe("other");
  });

  it("falls back to 'low' for unknown severity", () => {
    const body = `<healing>[issues]
- type: tool_failure
  severity: critical
  description: something
  suggestion: fix it
[/issues]</healing>`;
    const result = parseHealingReport(body);
    expect(result.issues[0].severity).toBe("low");
  });

  it("skips entries without description", () => {
    const body = `<healing>[issues]
- type: tool_failure
  severity: high
- type: missing_context
  severity: low
  description: actual description
  suggestion: fix
[/issues]</healing>`;
    const result = parseHealingReport(body);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].description).toBe("actual description");
  });

  // ── 防误解析 ──

  it("rejects healing block over 5000 chars", () => {
    const longDescription = "x".repeat(6000);
    const body = `<healing>[issues]
- type: other
  severity: low
  description: ${longDescription}
  suggestion: fix
[/issues]</healing>`;
    expect(parseHealingReport(body).hasIssues).toBe(false);
  });

  it("caps at MAX_ISSUES_PER_REPORT (10)", () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      `- type: other\n  severity: low\n  description: issue ${i}\n  suggestion: fix ${i}`
    ).join("\n");
    const body = `<healing>[issues]\n${entries}\n[/issues]</healing>`;
    const result = parseHealingReport(body);
    expect(result.issues).toHaveLength(10);
  });

  it("truncates description at 500 chars", () => {
    const longDesc = "a".repeat(600);
    const body = `<healing>[issues]
- type: other
  severity: low
  description: ${longDesc}
  suggestion: fix
[/issues]</healing>`;
    const result = parseHealingReport(body);
    expect(result.issues[0].description).toHaveLength(500);
  });

  it("handles no_issue with space variation", () => {
    expect(parseHealingReport("<healing>[no_issue]</healing>").hasIssues).toBe(false);
    expect(parseHealingReport("<healing>[no issue]</healing>").hasIssues).toBe(false);
  });
});

describe("stripHealingReport", () => {
  it("removes healing block from body", () => {
    const body = "Hello<healing>[no_issue]</healing>World";
    expect(stripHealingReport(body)).toBe("HelloWorld");
  });

  it("strips [no issue] (space variant) block", () => {
    const body = "Hello<healing>[no issue]</healing>World";
    expect(stripHealingReport(body)).toBe("HelloWorld");
  });

  // ── 误剥防护（F20260904hstr）──

  it("正文裸写/反引号引用标签字样不剥离（消息不丢内容）", () => {
    const body = "记忆溯源：F20260730sbrt——speak 内嵌 `<healing>` 块让海獭自报问题\n中间正文\n结尾";
    expect(stripHealingReport(body)).toBe(body);
  });

  it("正文引用 + 文末真报告块：只剥真块，正文完整保留", () => {
    const body = "正文提及 <healing> 字样\n```html-card title=\"卡片\"\n内容\n```\n<healing>[issues]\n- type: other\n  severity: low\n  description: x\n  suggestion: y\n[/issues]</healing>";
    const stripped = stripHealingReport(body);
    expect(stripped).toContain("正文提及 <healing> 字样");
    expect(stripped).toContain("html-card");
    expect(stripped).not.toMatch(/<healing>\s*\[issues\]/);
  });

  it("残缺报告块（缺 [/issues]）不剥离，保留原文", () => {
    const body = "A<healing>[issues]\n- type: other\n  severity: low\n  description: x\nB";
    expect(stripHealingReport(body)).toBe(body);
  });

  it("preserves content before and after", () => {
    const body = "Before\n<healing>[issues]\n- type: other\n  severity: low\n  description: x\n  suggestion: y\n[/issues]</healing>\nAfter";
    const stripped = stripHealingReport(body);
    expect(stripped).not.toContain("<healing>");
    expect(stripped).toContain("Before");
    expect(stripped).toContain("After");
  });

  it("collapses excessive newlines", () => {
    const body = "A\n\n\n\n\nB";
    expect(stripHealingReport(body)).toBe("A\n\nB");
  });

  it("handles no healing tag", () => {
    expect(stripHealingReport("normal text")).toBe("normal text");
  });
});
