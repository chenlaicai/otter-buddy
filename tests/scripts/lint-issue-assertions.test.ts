import { describe, it, expect } from "vitest";
import { extractAssertionSection, classifyAssertionDirection } from "../../scripts/lint-issue-assertions.mjs";

/**
 * 断言方向 lint 单测。样本取自真实 issue 原文形态（阈值型/只触发一次型/仍必现拒绝型/
 * 改写后仍≥基线型等，出处见特性文档）+ 边界形态。
 */

describe("extractAssertionSection", () => {
  it("提取 ## 验证断言 段到下一个 ## 之前", () => {
    const body = "## 案发现场\nX\n\n## 验证断言\n\n- 断言：rate 仍 > 3 条/周\n- 检查方式：sqlite\n- 到期：2026-12-19\n\n## 关闭标准\nY";
    const section = extractAssertionSection(body);
    expect(section).toContain("仍 > 3 条/周");
    expect(section).not.toContain("关闭标准");
    expect(section).not.toContain("案发现场");
  });

  it("无验证断言段返回 null", () => {
    expect(extractAssertionSection("## 案发现场\n只有现场")).toBeNull();
    expect(extractAssertionSection("")).toBeNull();
  });

  it("段首「暂不验证」返回 null（纯决策/容器型，规范允许）", () => {
    const body = "## 验证断言\n\n暂不验证：搭档拍板型容器，无机械判据\n\n## 其他";
    expect(extractAssertionSection(body)).toBeNull();
  });

  it("段在文末无后续 ## 也能提取", () => {
    const body = "前文\n\n## 验证断言\n\n- 断言：按钮仍静默";
    expect(extractAssertionSection(body)).toContain("仍静默");
  });
});

describe("classifyAssertionDirection", () => {
  it("问题还在方向（#1540 改写后形态）→ problem-ok", () => {
    expect(classifyAssertionDirection("- 断言：self_kill_nonliteral 族升 high 的周发生次数仍 ≥ 基线 3 条/周（较基线未下降）")).toBe("problem-ok");
  });

  it("问题还在方向（#1580 形态：仍必现拒绝）→ problem-ok", () => {
    expect(classifyAssertionDirection("- 断言：kill-by-pid 对 `~/.otter/alpha/<hash>` 路径仍必现拒绝")).toBe("problem-ok");
  });

  it("问题还在方向（仍不存在/率仍低于）→ problem-ok", () => {
    expect(classifyAssertionDirection("- 断言：止损线指标 X 仍不存在且 intent 率仍 <30%")).toBe("problem-ok");
  });

  it("纯阈值好结果断言（#1511 原文形态：≤ 阈值无其他好结果词）→ unclear（同样进改写路径，不漏）", () => {
    expect(classifyAssertionDirection("- 断言：30 天内 rate_limit severity=high 且含「配额耗尽」的新事件 ≤ 1 条/周（数据源：healing_events）")).toBe("unclear");
  });

  it("「未下降」含「下降」子串不误判好结果（否定形态剥离）", () => {
    expect(classifyAssertionDirection("- 断言：周发生次数仍 ≥ 基线 3 条/周（较基线未下降）")).toBe("problem-ok");
  });

  it("「未归零」含「归零」子串不误判好结果（#1766 改写后实证形态）", () => {
    expect(classifyAssertionDirection("- 断言：超龄告警事件 7 天观察窗内仍 >0（未归零），或存量 30 天后仍有 open+NULL 残留")).toBe("problem-ok");
  });

  it("好结果方向（#1553 原文形态：只触发一次）→ good-direction", () => {
    expect(classifyAssertionDirection("- 断言：同一 messageId 的 user entry 只触发一次回合（或重放条目带机械标记可供识别）")).toBe("good-direction");
  });

  it("好结果方向（#1949 形态：修复后能正常执行）→ good-direction", () => {
    const section = "修复后 `npm run build && node dist/scripts/...` 在全新构建下合入点闸可正常执行\nmerge_pr 对「脚本执行成功且判定通过」的 PR 能正常合入\n- 判据：下一个走 merge_pr 的合入全链路无 Cannot find module；到期 +30 天";
    expect(classifyAssertionDirection(section)).toBe("good-direction");
  });

  it("好结果方向（#1510 原文形态：行数为 0）→ good-direction", () => {
    expect(classifyAssertionDirection("- 断言：修复合入后，scheduled_task_executions 中坏账行数为 0（数据源：data/otter-buddy.db）")).toBe("good-direction");
  });

  it("复合断言保守判好结果（含仍又含修复后 → 交人工取向，不误放行）", () => {
    expect(classifyAssertionDirection("- 断言：修复后 X 不再发生且基线仍可复现")).toBe("good-direction");
  });

  it("检查方式/到期等元信息行不参与判定（好结果词只出现在检查方式里不算）", () => {
    const section = "- 断言：按钮失败态仍静默必现\n- 检查方式：mock 失败 → 断言出现错误反馈元素（当前必现静默）\n- 到期：2026-12-19";
    expect(classifyAssertionDirection(section)).toBe("problem-ok");
  });

  it("改写标注内嵌原文引用不参与判定（#1766 改写后实证：标注含「7 天内归零」仍判 problem-ok）", () => {
    expect(classifyAssertionDirection("- 断言：超龄告警事件 7 天观察窗内仍 >0（未归零）【2026-11-19 lint 改写：原断言为好结果方向（「7 天内归零」「全部离开」），机械取反；原文见 #1963】")).toBe("problem-ok");
  });

  it("两侧标记都不命中 → unclear（方向不明，同样需改写）", () => {
    expect(classifyAssertionDirection("- 断言：观察 30 天后复盘定性")).toBe("unclear");
  });
});
