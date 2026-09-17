/**
 * #998：healing errorType 二维分账（环境/系统失败 vs 獭能力失败）映射测试。
 *
 * 伤疤来源：#791 同类教训——口径混排（error_type 字段值与 description 分类混排一表）
 * 把真实信号拆散隐去。二维分账让「工具故障」与「獭不行」在统计层分离，
 * 两种误判的处置方向完全相反。
 */
import { describe, it, expect } from "vitest";
import { classifyHealingErrorType, type HealingErrorType } from "../../../src/entities/healing/healing-event";

describe("classifyHealingErrorType（#998 二维分账）", () => {
  it("环境/系统类：tool_failure / rate_limit / circuit_break / self_restart / guard_intercept", () => {
    for (const t of ["tool_failure", "rate_limit", "circuit_break", "self_restart", "guard_intercept"] as HealingErrorType[]) {
      expect(classifyHealingErrorType(t)).toBe("environment");
    }
  });

  it("獭能力类：missing_context / wrong_tool / format_violation / knowledge_gap / performance / degenerate / tool_use_feedback", () => {
    for (const t of ["missing_context", "wrong_tool", "format_violation", "knowledge_gap", "performance", "degenerate", "tool_use_feedback"] as HealingErrorType[]) {
      expect(classifyHealingErrorType(t)).toBe("capability");
    }
  });

  it("other 归 capability（Unknown 保守归因于獭，不粉饰系统）", () => {
    expect(classifyHealingErrorType("other")).toBe("capability");
  });

  it("全枚举覆盖：12 个 errorType 全部被分类（新增枚举不加分类会在此现形）", () => {
    const all: HealingErrorType[] = [
      "tool_failure", "missing_context", "wrong_tool", "format_violation", "knowledge_gap",
      "performance", "degenerate", "circuit_break", "self_restart", "guard_intercept",
      "rate_limit", "tool_use_feedback", "other",
    ];
    const results = all.map(classifyHealingErrorType);
    expect(results.every((r) => r === "environment" || r === "capability")).toBe(true);
    expect(new Set(results).size).toBe(2); // 两类都有覆盖
  });
});
