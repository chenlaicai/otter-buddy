import { describe, it, expect } from "vitest";
import { buildCostOutputSnapshotRows } from "@usecases/health/cost-output-rows";
import type { OtterCostRecord, OtterOutputRecord, DispatchCountRecord } from "@usecases/health/cost-output-collector";

function fakeCostRecord(overrides?: Partial<OtterCostRecord>): OtterCostRecord {
  return {
    date: "2026-08-28",
    otterId: "otter-aaa",
    otterName: "大獭",
    otterType: "big",
    model: "mimo-v2.5-pro",
    inputTokens: 10000,
    outputTokens: 500,
    cacheReadTokens: 3000,
    cacheWriteTokens: 200,
    totalTokens: 13700,
    costInput: 0.1,
    costOutput: 0.025,
    costCacheRead: 0.003,
    costCacheWrite: 0.0002,
    costTotal: 0.1282,
    callCount: 5,
    cacheHitRate: 0.23,
    ...overrides,
  };
}

function fakeOutputRecord(overrides?: Partial<OtterOutputRecord>): OtterOutputRecord {
  return {
    date: "2026-08-28",
    otterId: "otter-aaa",
    otterName: "大獭",
    messageCount: 42,
    toolCallCount: 15,
    ...overrides,
  };
}

describe("buildCostOutputSnapshotRows", () => {
  it("每条 cost 记录生成 12 行（12 个指标键）", () => {
    const rows = buildCostOutputSnapshotRows("2026-08-28", [fakeCostRecord()], []);
    expect(rows.length).toBe(12);
    for (const r of rows) {
      expect(r.metricType).toBe("cost_output");
      expect(r.snapshotDate).toBe("2026-08-28");
    }
  });

  it("每条 output 记录生成 2 行（message_count + tool_call_count）", () => {
    const rows = buildCostOutputSnapshotRows("2026-08-28", [], [fakeOutputRecord()]);
    expect(rows.length).toBe(2);
    const msgRow = rows.find(r => r.metricKey === "message_count")!;
    expect(msgRow.metricValue).toBe(42);
    const toolRow = rows.find(r => r.metricKey === "tool_call_count")!;
    expect(toolRow.metricValue).toBe(15);
  });

  it("多条 cost + 多条 output 记录的总行数", () => {
    const costs = [fakeCostRecord(), fakeCostRecord({ otterId: "otter-bbb", otterName: "小獭甲" })];
    const outputs = [fakeOutputRecord(), fakeOutputRecord({ otterId: "otter-bbb", otterName: "小獭甲", messageCount: 10, toolCallCount: 3 })];
    const rows = buildCostOutputSnapshotRows("2026-08-28", costs, outputs);
    // 2 cost × 12 + 2 output × 2 = 28
    expect(rows.length).toBe(28);
  });

  it("metadata 是合法 JSON 且含 otter 标识", () => {
    const rows = buildCostOutputSnapshotRows("2026-08-28", [fakeCostRecord()], [fakeOutputRecord()]);
    for (const r of rows) {
      const meta = JSON.parse(r.metadata!);
      expect(meta.otterId).toBe("otter-aaa");
      expect(meta.otterName).toBe("大獭");
    }
  });

  it("cost 行的 metadata 含 model 字段", () => {
    const rows = buildCostOutputSnapshotRows("2026-08-28", [fakeCostRecord()], []);
    for (const r of rows) {
      const meta = JSON.parse(r.metadata!);
      expect(meta.model).toBe("mimo-v2.5-pro");
      expect(meta.otterType).toBe("big");
    }
  });

  it("指标值正确映射", () => {
    const rec = fakeCostRecord();
    const rows = buildCostOutputSnapshotRows("2026-08-28", [rec], []);
    const byKey = new Map(rows.map(r => [r.metricKey, r.metricValue]));
    expect(byKey.get("input_tokens")).toBe(10000);
    expect(byKey.get("output_tokens")).toBe(500);
    expect(byKey.get("cache_read_tokens")).toBe(3000);
    expect(byKey.get("total_tokens")).toBe(13700);
    expect(byKey.get("cost_total")).toBeCloseTo(0.1282);
    expect(byKey.get("llm_call_count")).toBe(5);
    expect(byKey.get("cache_hit_rate")).toBeCloseTo(0.23);
  });

  it("PR 数行按日期生成（全局，无 per-otter 维度）", () => {
    const prRecords = [
      { date: "2026-08-27", prCount: 3 },
      { date: "2026-08-28", prCount: 5 },
    ];
    const rows = buildCostOutputSnapshotRows("2026-08-28", [], [], { prRecords });
    expect(rows.length).toBe(2);
    expect(rows[0]!.metricKey).toBe("pr_count");
    expect(rows[0]!.metricValue).toBe(3);
    expect(rows[0]!.snapshotDate).toBe("2026-08-27");
    expect(rows[0]!.metadata).toBe("{}");
    expect(rows[1]!.metricValue).toBe(5);
  });

  it("F 文档数行按日期生成（全局，无 per-otter 维度）", () => {
    const fdocRecords = [
      { date: "2026-08-28", fdocCount: 2 },
      { date: "2026-08-29", fdocCount: 1 },
    ];
    const rows = buildCostOutputSnapshotRows("2026-08-28", [], [], { fdocRecords });
    expect(rows.length).toBe(2);
    expect(rows[0]!.metricKey).toBe("fdoc_count");
    expect(rows[0]!.metricValue).toBe(2);
    expect(rows[0]!.metadata).toBe("{}");
  });

  it("dispatch 任务完成数行按日期生成（全局，无 per-otter 维度）", () => {
    const dispatchRecords: DispatchCountRecord[] = [
      { date: "2026-08-28", dispatchCount: 3 },
      { date: "2026-08-29", dispatchCount: 1 },
    ];
    const rows = buildCostOutputSnapshotRows("2026-08-28", [], [], { dispatchRecords });
    expect(rows.length).toBe(2);
    expect(rows[0]!.metricKey).toBe("dispatch_count");
    expect(rows[0]!.metricValue).toBe(3);
    expect(rows[0]!.metadata).toBe("{}")
    expect(rows[1]!.metricKey).toBe("dispatch_count");
    expect(rows[1]!.metricValue).toBe(1);
  });

  it("空输入返回空数组", () => {
    const rows = buildCostOutputSnapshotRows("2026-08-28", [], [], {});
    expect(rows).toEqual([]);
  });
});
