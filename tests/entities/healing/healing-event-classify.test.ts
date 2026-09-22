/**
 * #998：healing errorType 二维分账（环境/系统失败 vs 獭能力失败）映射测试。
 *
 * 伤疤来源：#791 同类教训——口径混排（error_type 字段值与 description 分类混排一表）
 * 把真实信号拆散隐去。二维分账让「工具故障」与「獭不行」在统计层分离，
 * 两种误判的处置方向完全相反。
 *
 * PR #1024 检视修正：guard_intercept 归能力（生产库 37% 第一大类，被拦的是獭的危险动作）；
 * tool_use_feedback 移出分账（主动反馈信号不是失败事件）。
 */
import { describe, it, expect } from "vitest";
import {
  classifyHealingErrorType,
  HEALING_ENVIRONMENT_TYPES,
  HEALING_FEEDBACK_TYPES,
  type HealingErrorType,
} from "../../../src/entities/healing/healing-event";

describe("classifyHealingErrorType（#998 二维分账）", () => {
  it("环境/系统类：tool_failure / rate_limit / circuit_break / self_restart", () => {
    for (const t of ["tool_failure", "rate_limit", "circuit_break", "self_restart"] as HealingErrorType[]) {
      expect(classifyHealingErrorType(t)).toBe("environment");
    }
  });

  it("獭能力类：missing_context / wrong_tool / format_violation / knowledge_gap / performance / degenerate / guard_intercept", () => {
    // guard_intercept 归能力：被拦的是獭发出的危险动作，守卫本身工作正常（PR #1024 检视发现 2）
    for (const t of ["missing_context", "wrong_tool", "format_violation", "knowledge_gap", "performance", "degenerate", "guard_intercept"] as HealingErrorType[]) {
      expect(classifyHealingErrorType(t)).toBe("capability");
    }
  });

  it("tool_use_feedback 不入分账（主动反馈信号，独立列；PR #1024 检视发现 1）", () => {
    expect(classifyHealingErrorType("tool_use_feedback")).toBeNull();
  });

  it("other 归 capability（Unknown 保守归因于獭，不粉饰系统）", () => {
    expect(classifyHealingErrorType("other")).toBe("capability");
  });

  it("全枚举覆盖：14 个 errorType 全部被分类（环境清单/反馈清单/默认能力三通道）", () => {
    const all: HealingErrorType[] = [
      "tool_failure", "missing_context", "wrong_tool", "format_violation", "knowledge_gap",
      "performance", "degenerate", "circuit_break", "self_restart", "guard_intercept",
      "rate_limit", "tool_use_feedback", "timeout_retry_exhausted", "other",
    ];
    const results = all.map(classifyHealingErrorType);
    expect(results.filter((r) => r === "environment").length).toBe(HEALING_ENVIRONMENT_TYPES.length);
    expect(results.filter((r) => r === null).length).toBe(HEALING_FEEDBACK_TYPES.length);
    expect(results.filter((r) => r === "capability").length).toBe(all.length - HEALING_ENVIRONMENT_TYPES.length - HEALING_FEEDBACK_TYPES.length);
  });
});
