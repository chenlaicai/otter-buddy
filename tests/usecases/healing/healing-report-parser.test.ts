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

  it("handles backtick-wrapped tags", () => {
    const body = "`<healing>`[no_issue]`</healing>`";
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
