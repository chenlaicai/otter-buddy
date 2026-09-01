import { describe, it, expect } from "vitest";
import { diffHealthIndex, buildSnapshotShiftEvidence, SNAPSHOT_SHIFT_THRESHOLD } from "@usecases/health/snapshot-shift";
import type { HealthIndexSnapshot } from "@usecases/health/snapshot-shift";

/** 五维 + overall 快照行工厂 */
function rows(date: string, values: Partial<Record<string, number | null>>): HealthIndexSnapshot[] {
  const keys = ["D1", "D2", "D3", "D4", "D5", "overall"];
  return keys.map(k => ({ snapshotDate: date, metricKey: k, metricValue: k in values ? values[k]! : 80 }));
}

describe("diffHealthIndex（Issue #645 环比骤变）", () => {
  it("无维度超阈 → 不触发", () => {
    const diff = diffHealthIndex(rows("2026-08-30", {}), rows("2026-08-31", {}));
    expect(diff.triggered).toBe(false);
    expect(diff.shifts).toHaveLength(0);
  });

  it("单维度 |Δ|≥10 触发，shifts 带前后值与带符号 delta", () => {
    const prev = rows("2026-08-30", { D3: 80 });
    const cur = rows("2026-08-31", { D3: 68 });
    const diff = diffHealthIndex(prev, cur);
    expect(diff.triggered).toBe(true);
    const shift = diff.shifts.find(s => s.dimension === "D3")!;
    expect(shift.previous).toBe(80);
    expect(shift.current).toBe(68);
    expect(shift.delta).toBe(-12);
  });

  it("阈值边界：|Δ|=10 触发（≥ 口径），|Δ|=9 不触发", () => {
    const at = diffHealthIndex(rows("d0", { D1: 70 }), rows("d1", { D1: 80 }));
    expect(at.triggered).toBe(true);

    const below = diffHealthIndex(rows("d0", { D1: 71 }), rows("d1", { D1: 80 }));
    expect(below.triggered).toBe(false);
    expect(SNAPSHOT_SHIFT_THRESHOLD).toBe(10);
  });

  it("null 维度跳过并注明（无数据≠骤变），不算 Δ 不触发", () => {
    const prev = rows("2026-08-30", { D3: null });
    const cur = rows("2026-08-31", { D3: 30 }); // 若误算 Δ=-50 会误报；null 跳过
    const diff = diffHealthIndex(prev, cur);
    expect(diff.triggered).toBe(false);
    expect(diff.skipped.find(s => s.dimension === "D3")?.reason).toContain("前一日无数据");
  });

  it("当日 null 维度同样跳过（回填历史无链数据场景）", () => {
    const prev = rows("2026-08-30", { D3: 90 });
    const cur = rows("2026-08-31", { D3: null });
    const diff = diffHealthIndex(prev, cur);
    expect(diff.triggered).toBe(false);
    expect(diff.skipped.find(s => s.dimension === "D3")?.reason).toContain("当日无数据");
  });

  it("前一日缺维度 → skipped（无法环比），不炸", () => {
    const prev = rows("2026-08-30", {}).slice(0, 5); // 少 overall
    const cur = rows("2026-08-31", {});
    const diff = diffHealthIndex(prev, cur);
    expect(diff.triggered).toBe(false);
    expect(diff.skipped.find(s => s.dimension === "overall")?.reason).toContain("前一日无此维度");
  });

  it("多维度同时骤变全部报出（overall 与维度独立判定）", () => {
    const prev = rows("2026-08-30", { D1: 80, D3: 80 });
    const cur = rows("2026-08-31", { D1: 65, D3: 95 });
    const diff = diffHealthIndex(prev, cur);
    expect(diff.triggered).toBe(true);
    expect(diff.shifts.map(s => s.dimension).sort()).toEqual(["D1", "D3"]);
  });
});

describe("buildSnapshotShiftEvidence", () => {
  it("evidence 含日期、维度名、前后值与带符号 delta", () => {
    const prev = rows("2026-08-30", { D3: 80 });
    const cur = rows("2026-08-31", { D3: 68 });
    const diff = diffHealthIndex(prev, cur);
    const { evidence, suggestedAction } = buildSnapshotShiftEvidence(diff, {
      previousDate: "2026-08-30",
      currentDate: "2026-08-31",
    });
    expect(evidence).toContain("2026-08-30→2026-08-31");
    expect(evidence).toContain("交付活力 80→68（Δ-12）");
    expect(suggestedAction).toContain("深挖 2026-08-31");
    expect(suggestedAction).toContain("交付活力");
  });

  it("evidence 注明跳过的 null 维度（消费者可读原因）", () => {
    const prev = rows("2026-08-30", { D3: null, D1: 80 });
    const cur = rows("2026-08-31", { D3: 30, D1: 65 });
    const diff = diffHealthIndex(prev, cur);
    const { evidence } = buildSnapshotShiftEvidence(diff, {
      previousDate: "2026-08-30",
      currentDate: "2026-08-31",
    });
    expect(evidence).toContain("跳过");
    expect(evidence).toContain("D3");
  });
});
