/**
 * #1704：commitInWindow 窗口归属回归——跨时区 author date 在窗口边界日的归属
 * 必须按时间戳语义判定，不得随字符串字典序/当日时刻翻转。
 *
 * 原 bug：rhi-scan-worker.ts:345 用 `c.date >= windowStart` 字符串比较，混比 %aI
 * （带原时区偏移）与 toISOString()（UTC 'Z'）两种格式——边界日翻转于当日 UTC 10:00
 * 前后（'T10:00:00+08:00' 字面量边界），CI run 40862931480 实爆。
 */
import { describe, it, expect } from "vitest";
import { commitInWindow } from "../../../src/usecases/health/rhi-scan-worker";

describe("commitInWindow 窗口归属（#1704 跨时区字典序错位回归）", () => {
  // 窗口边界日的 +08:00 author date = UTC 2026-08-30T02:00:00Z
  const boundaryCommit = "2026-08-30T10:00:00+08:00";

  it("UTC 10:00 字面量边界两侧：归属按时间戳语义（修复前字典序在 T03:00 误判 true）", () => {
    // windowStart UTC 01:00 < commit UTC 02:00 → 在窗口（true）；字典序恰好同向
    expect(commitInWindow(boundaryCommit, "2026-08-30T01:00:00.000Z")).toBe(true);
    // windowStart UTC 03:00 > commit UTC 02:00 → 不在窗口（false）；
    // 修复前字符串比较：'…T10:00…' > '…T03:00…' → 误判 true（回归锁定点）
    expect(commitInWindow(boundaryCommit, "2026-08-30T03:00:00.000Z")).toBe(false);
  });

  it("跨日边界：+08:00 的凌晨 author date 归属前一 UTC 日，不落入次日窗口", () => {
    // "2026-08-30T02:00:00+08:00" = 2026-08-29T18:00:00Z，早于 windowStart 2026-08-30T01:00Z
    // 修复前字符串比较：'…T02:00…' > '…T01:00…' → 误判 true
    expect(commitInWindow("2026-08-30T02:00:00+08:00", "2026-08-30T01:00:00.000Z")).toBe(false);
  });

  it("等号边界：commit 与窗口起点同刻 → 在窗口（锁定 >= 不被改成 >）", () => {
    expect(commitInWindow("2026-08-30T02:00:00Z", "2026-08-30T02:00:00.000Z")).toBe(true);
    expect(commitInWindow("2026-08-30T02:00:00+08:00", "2026-08-30T02:00:00.000Z")).toBe(false);
  });

  it("窗口内深处稳定包含", () => {
    expect(commitInWindow("2026-10-26T10:00:00+08:00", "2026-08-30T11:12:00.000Z")).toBe(true);
    expect(commitInWindow("2026-08-30T23:00:00+08:00", "2026-08-30T11:12:00.000Z")).toBe(true);
  });
});
