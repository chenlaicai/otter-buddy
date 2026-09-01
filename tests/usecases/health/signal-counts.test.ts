import { describe, it, expect } from "vitest";
import { aggregateOpenSignalCounts } from "@usecases/health/signal-counts";
import type { SignalRecord } from "@usecases/health/signal-repository";

/** Issue #652：open 信号计数口径（confidence=low 不进 severity 计数，单列 byConfidence） */

function rec(overrides: Partial<SignalRecord>): SignalRecord {
  return {
    id: 1,
    signal_type: "chain_stall",
    severity: "critical",
    feature_id: null,
    file_path: null,
    evidence: "e",
    first_seen: "2026-09-01T00:00:00Z",
    last_seen: "2026-09-01T00:00:00Z",
    occurrences: 1,
    status: "open",
    suggested_action: null,
    created_at: "2026-09-01T00:00:00Z",
    resolved_at: null,
    evidence_detail: null,
    confidence: null,
    ...overrides,
  };
}

describe("aggregateOpenSignalCounts（Issue #652 口径单一真相源）", () => {
  it("issue 验收原文场景：low critical ×2 + normal critical ×1 → critical 计数 = 1", () => {
    const open = [
      rec({ id: 1, severity: "critical", confidence: "low" }),
      rec({ id: 2, severity: "critical", confidence: "low" }),
      rec({ id: 3, severity: "critical", confidence: null }),
    ];
    const { bySeverity, byConfidence } = aggregateOpenSignalCounts(open);
    expect(bySeverity.critical).toBe(1);
    expect(bySeverity.warning).toBe(0);
    expect(byConfidence.low).toBe(2);
    expect(byConfidence.normal).toBe(1);
  });

  it("COALESCE 语义：confidence=null/undefined 存量信号按 normal 计入 severity", () => {
    const open = [
      rec({ severity: "critical", confidence: null }),
      rec({ severity: "warning", confidence: undefined as unknown as null }),
    ];
    const { bySeverity, byConfidence } = aggregateOpenSignalCounts(open);
    expect(bySeverity).toEqual({ critical: 1, warning: 1 });
    expect(byConfidence).toEqual({ normal: 2, low: 0 });
  });

  it("未知 confidence 值按 normal 处理（不丢计数）", () => {
    const open = [rec({ severity: "critical", confidence: "bogus" as unknown as null })];
    const { bySeverity, byConfidence } = aggregateOpenSignalCounts(open);
    expect(bySeverity.critical).toBe(1);
    expect(byConfidence.normal).toBe(1);
  });

  it("low warning 同样不进 warning 计数", () => {
    const open = [
      rec({ severity: "warning", confidence: "low" }),
      rec({ severity: "warning", confidence: "normal" }),
    ];
    const { bySeverity, byConfidence } = aggregateOpenSignalCounts(open);
    expect(bySeverity.warning).toBe(1);
    expect(byConfidence.low).toBe(1);
  });
});
