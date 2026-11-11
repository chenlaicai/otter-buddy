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

  it("parses tool_use_feedback type with [tool:name] prefix (F20260904tflp)", () => {
    const body = `<healing>[issues]
- type: tool_use_feedback
  severity: low
  description: [tool:get_related] direction 参数 in/out 语义反直觉，每次都要试错
  suggestion: 交换默认值或加对照示例
[/issues]</healing>`;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(true);
    expect(result.issues[0].type).toBe("tool_use_feedback");
    expect(result.issues[0].description).toContain("[tool:get_related]");
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

  it("rejects the whole block when any entry lacks description", () => {
    const body = `<healing>[issues]
- type: tool_failure
  severity: high
- type: missing_context
  severity: low
  description: actual description
  suggestion: fix
[/issues]</healing>`;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.invalidBlocks).toHaveLength(1);
    expect(result.invalidBlocks[0].reason).toContain("description");
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

  it("strips JSON no_issue variant without leaking protocol metadata", () => {
    const body = "已完成。\n\n<healing>\n{\"type\":\"no_issue\"}\n</healing>";
    expect(stripHealingReport(body)).toBe("已完成。");
  });

  it("preserves non-protocol JSON inside healing tags", () => {
    const body = "代码示例：<healing>{\"type\":\"example\"}</healing>";
    expect(stripHealingReport(body)).toBe(body);
  });

  it("strips fenced healing JSON no_issue variants (F20261110hjfnx)", () => {
    const bodies = [
      "已完成。\n\n```healing\n{\"no_issue\": true}\n```",
      "已完成。\n\n```healing\n{\"type\":\"no_issue\"}\n```",
    ];
    for (const body of bodies) expect(stripHealingReport(body)).toBe("已完成。");
  });

  it("strips an empty fenced no_issue control block", () => {
    const body = "已完成。\n\n```no_issue\n```";
    expect(stripHealingReport(body)).toBe("已完成。");
  });

  it("preserves non-protocol fenced JSON and ordinary JSON examples", () => {
    const bodies = [
      "代码示例：\n```healing\n{\"type\":\"example\"}\n```",
      "代码示例：\n```json\n{\"no_issue\":true}\n```",
    ];
    for (const body of bodies) expect(stripHealingReport(body)).toBe(body);
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

  it("残缺块（缺 [/issues] 闭合标记但有 </healing>）会被剥掉，不残留结构化数据", () => {
    // strip 不要求 [/issues] 成对——只要有开头标记 + </healing> 闭合就剥。
    // 反驳审视发现 1 的实测证据（PR #787 审视处置）：此场景不会残留。
    const body = "正文A\n<healing>[issues]\n- type: other\n  severity: low\n  description: x\n</healing>\n正文B";
    const stripped = stripHealingReport(body);
    expect(stripped).toContain("正文A");
    expect(stripped).toContain("正文B");
    expect(stripped).not.toContain("type:");
  });

  it("残缺块（缺 </healing> 闭合标签）不剥离，保留原文", () => {
    // 无闭合标签时旧版同样剥不掉（旧正则也需要 </healing>），行为无变化。
    // fail-open 设计：宁可多显示也不丢正文（2026-09-04 两次吞正文现场）。
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

// ── issue #1842：上报协议与解析器不一致（F20261111hrepl）──
describe("issue #1842 healing 协议契约", () => {
  // 原始现场：JSON 单对象块（message d08860a8）
  it("parses JSON 单对象 healing 块（真实现场：runtime_status_mismatch）", () => {
    const body = `当事人情况上报：我这边确实正在运行……

<healing>
{"type":"runtime_status_mismatch","description":"用户看到大獭状态为休息中，但大獭实际正在执行方案分析，连续发生工具调用","suggestion":"排查重启后 invoke/otter 运行态与前端休息中投影的关联"}
</healing>`;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect((result.issues[0] as { type: string }).type).toBe("runtime_status_mismatch");
    expect(result.issues[0].description).toContain("实际正在执行");
    expect(result.issues[0].suggestion).toContain("重启");
  });

  // 完整原始现场（message d08860a8 全文）：多段正文 + JSON 单对象块——落账且剥离不损坏正文
  it("完整原始现场：JSON 单对象落账 + strip 前文正文完整保留", () => {
    const body = `当事人情况上报：我这边**确实正在运行**，正在连续执行“CoLink × 海獭 Agent App”方案分析。

补充时间线：我在你开始这项新任务前按要求执行过一次自重启，随后继续运行。

<healing>
{"type":"runtime_status_mismatch","description":"用户看到大獭状态为休息中，但大獭实际正在执行方案分析，连续发生 search_memory/bash 等工具调用","suggestion":"排查重启后 invoke/otter 运行态与前端休息中投影的关联"}
</healing>`;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe("runtime_status_mismatch");

    const stripped = stripHealingReport(body);
    expect(stripped).toContain("当事人情况上报");
    expect(stripped).toContain("补充时间线");
    expect(stripped).not.toContain("<healing>");
    expect(stripped).not.toContain("runtime_status_mismatch");
  });

  // R5 文档示范形态（占位符替换后的具体正例——修复后文档将以此为准）
  it("parses R5 文档列表正例（- type: 项 + [/issues] 闭合）", () => {
    const body = `<healing>[issues]
- type: tool_failure
  severity: high
  description: search_memory 返回空结果
  suggestion: 检查 embedding 服务状态
[/issues]
</healing>`;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe("tool_failure");
  });

  // R5 文档 JSON 单对象正例（修复后文档新增形态，同样须过 parser）
  it("parses R5 文档 JSON 单对象正例", () => {
    const body = `<healing>
{"type":"tool_failure","severity":"high","description":"一句话描述问题","suggestion":"建议的处置"}
</healing>`;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].type).toBe("tool_failure");
    expect(result.issues[0].severity).toBe("high");
  });

  // 讲解示例（代码围栏内）不得落账
  it("代码围栏内的合法 YAML 列表形状是讲解示例，不落账", () => {
    const body = `当前解析器只接受这种形状：

\`\`\`text
<healing>[issues]
- type: other
  severity: high
  description: ...
  suggestion: ...
[/issues]
</healing>
\`\`\``;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it("代码围栏内的 JSON 单对象讲解示例不落账", () => {
    const body = `但当事獭实际发的是：

\`\`\`text
<healing>
{"type":"runtime_status_mismatch","description":"..."}
</healing>
\`\`\``;
    const result = parseHealingReport(body);
    expect(result.hasIssues).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it("strip 不剥离代码围栏内的讲解示例（正文不损坏）", () => {
    const body = `当前解析器只接受这种形状：

\`\`\`text
<healing>[issues]
- type: other
  severity: high
  description: ...
  suggestion: ...
[/issues]
</healing>
\`\`\``;
    const stripped = stripHealingReport(body);
    expect(stripped).toContain("<healing>[issues]");
    expect(stripped).toContain("description: ...");
  });

  // 非法块（非 no_issue 但无法解析）需要可操作反馈
  it("非法 JSON 块（缺 type）被识别为非法块（invalidBlocks 非空）", () => {
    const body = `<healing>
{"description":"没有 type 字段"}
</healing>`;
    const result = parseHealingReport(body);
    expect(result.invalidBlocks).toBeDefined();
    expect(result.invalidBlocks!.length).toBeGreaterThan(0);
  });

  it("[issues] 缺 [/issues] 闭合被识别为非法块", () => {
    const body = `<healing>[issues]
- type: tool_failure
  severity: low
  description: 残缺块
</healing>`;
    const result = parseHealingReport(body);
    expect(result.invalidBlocks).toBeDefined();
    expect(result.invalidBlocks!.length).toBeGreaterThan(0);
  });

  it("合法协议 type 缺 description 时是非法块，不静默当讲解示例", () => {
    const result = parseHealingReport('<healing>{"type":"tool_failure"}</healing>');
    expect(result.hasIssues).toBe(false);
    expect(result.invalidBlocks).toHaveLength(1);
    expect(result.invalidBlocks[0].reason).toContain("description");
  });

  it("JSON 数组明确拒绝并提示不支持数组", () => {
    const result = parseHealingReport('<healing>[{"type":"other","description":"x"}]</healing>');
    expect(result.hasIssues).toBe(false);
    expect(result.invalidBlocks).toHaveLength(1);
    expect(result.invalidBlocks[0].reason).toContain("数组");
  });

  it("真实 JSON 上报缺 </healing> 时响亮报错", () => {
    const result = parseHealingReport('<healing>{"type":"other","description":"x"}');
    expect(result.hasIssues).toBe(false);
    expect(result.invalidBlocks).toHaveLength(1);
    expect(result.invalidBlocks[0].reason).toContain("</healing>");
  });

  it("真实 issues 上报缺 </healing> 时响亮报错", () => {
    const result = parseHealingReport(`<healing>[issues]
- type: other
  description: x
[/issues]`);
    expect(result.hasIssues).toBe(false);
    expect(result.invalidBlocks).toHaveLength(1);
    expect(result.invalidBlocks[0].reason).toContain("</healing>");
  });
});

describe("PR #1851 对抗检视第一轮反例", () => {
  it("YAML 条目缺 type 时整个块非法，不归 other 落账", () => {
    const result = parseHealingReport(`<healing>[issues]
- severity: high
  description: missing type
[/issues]</healing>`);
    expect(result.hasIssues).toBe(false);
    expect(result.invalidBlocks).toHaveLength(1);
    expect(result.invalidBlocks[0].reason).toContain("type");
  });

  it("同块任一 YAML 条目缺 description 时整个块非法，不过滤后继续落账", () => {
    const result = parseHealingReport(`<healing>[issues]
- type: tool_failure
  severity: high
- type: other
  description: otherwise valid
[/issues]</healing>`);
    expect(result.hasIssues).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.invalidBlocks).toHaveLength(1);
    expect(result.invalidBlocks[0].reason).toContain("description");
  });

  it("四反引号围栏内嵌三反引号时示例仍受保护", () => {
    const body = `讲解：
\`\`\`\`text
\`\`\`
<healing>{"type":"other","description":"example"}</healing>
\`\`\`
\`\`\`\``;
    expect(parseHealingReport(body).hasIssues).toBe(false);
    expect(stripHealingReport(body)).toBe(body);
  });

  it("波浪围栏内的反引号行不会提前结束保护域", () => {
    const body = `讲解：
~~~text
\`\`\`
<healing>{"type":"other","description":"example"}</healing>
\`\`\`
~~~`;
    expect(parseHealingReport(body).hasIssues).toBe(false);
    expect(stripHealingReport(body)).toBe(body);
  });

  it("行内代码中的完整 JSON healing 示例不落账也不剥离", () => {
    const body = '讲解：`<healing>{"type":"other","description":"example"}</healing>`';
    expect(parseHealingReport(body).hasIssues).toBe(false);
    expect(stripHealingReport(body)).toBe(body);
  });

  it("行内示例与文末真上报并存时只处理真上报", () => {
    const body = '讲解：`<healing>{"type":"other","description":"example"}</healing>`\n<healing>{"type":"tool_failure","description":"real"}</healing>';
    const result = parseHealingReport(body);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].description).toBe("real");
    const stripped = stripHealingReport(body);
    expect(stripped).toContain('`<healing>{"type":"other","description":"example"}</healing>`');
    expect(stripped).not.toContain('"real"');
  });

  it("真实 JSON description 中的行内反引号内容原样保留", () => {
    const result = parseHealingReport('<healing>{"type":"other","description":"use `alpha` here"}</healing>');
    expect(result.hasIssues).toBe(true);
    expect(result.issues[0].description).toBe("use `alpha` here");
  });
});
