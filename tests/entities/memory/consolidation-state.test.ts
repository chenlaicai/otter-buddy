/**
 * F20261118nrcst P2b1：consolidation_state 实体单测。
 *
 * 覆盖：幂等键构造/回解的形态边界、空白状态、失败区间的形态一致性校验。
 */
import { describe, it, expect } from "vitest";
import {
  buildReviewKey,
  parseReviewKey,
  newConsolidationState,
  hasCoherentFailureRange,
  isValidReviewDate,
} from "@entities/memory/consolidation-state";

describe("buildReviewKey（F20261118nrcst P2b1）", () => {
  it("合法 date + taskId 构造 review:{date}:{taskId}", () => {
    expect(buildReviewKey("2026-11-18", "task-7")).toBe("review:2026-11-18:task-7");
  });

  it("date 非 YYYY-MM-DD 抛错（fail-closed）", () => {
    expect(() => buildReviewKey("18-11-2026", "task-7")).toThrow();
    expect(() => buildReviewKey("2026/11/18", "task-7")).toThrow();
    expect(() => buildReviewKey("20261118", "task-7")).toThrow();
  });

  it("taskId 为空抛错（防不同任务撞同一份结果）", () => {
    expect(() => buildReviewKey("2026-11-18", "")).toThrow();
    expect(() => buildReviewKey("2026-11-18", "   ")).toThrow();
  });
});

describe("parseReviewKey（F20261118nrcst P2b1）", () => {
  it("从合法键回解 date 与 taskId（taskId 可含冒号）", () => {
    expect(parseReviewKey("review:2026-11-18:a:b")).toEqual({ date: "2026-11-18", taskId: "a:b" });
  });

  it("非法键返回 null", () => {
    expect(parseReviewKey("review:2026-11-18:")).toBeNull();
    expect(parseReviewKey("review:bad-date:task")).toBeNull();
    expect(parseReviewKey("other:2026-11-18:task")).toBeNull();
    expect(parseReviewKey("review:2026-11-18")).toBeNull();
  });
});

describe("newConsolidationState（F20261118nrcst P2b1）", () => {
  it("空白状态：零失败、无区间、无结果", () => {
    const s = newConsolidationState("review:2026-11-18:t", "2026-11-18T09:00:00Z");
    expect(s.failures).toBe(0);
    expect(s.failedAfter).toBeNull();
    expect(s.failedThrough).toBeNull();
    expect(s.resultJson).toBeNull();
    expect(s.updatedAt).toBe("2026-11-18T09:00:00Z");
  });
});

describe("hasCoherentFailureRange（F20261118nrcst P2b1）", () => {
  it("两端同空或同非空为一致", () => {
    expect(hasCoherentFailureRange({ failedAfter: null, failedThrough: null })).toBe(true);
    expect(hasCoherentFailureRange({ failedAfter: "a", failedThrough: "b" })).toBe(true);
  });

  it("半空区间为不一致（连败计数无法绑定区间）", () => {
    expect(hasCoherentFailureRange({ failedAfter: "a", failedThrough: null })).toBe(false);
    expect(hasCoherentFailureRange({ failedAfter: null, failedThrough: "b" })).toBe(false);
  });
});

describe("isValidReviewDate（F20261118nrcst P2b1）", () => {
  it("只认 YYYY-MM-DD 字符串", () => {
    expect(isValidReviewDate("2026-11-18")).toBe(true);
    expect(isValidReviewDate("2026-1-18")).toBe(false);
    expect(isValidReviewDate(20261118 as unknown as string)).toBe(false);
  });
});