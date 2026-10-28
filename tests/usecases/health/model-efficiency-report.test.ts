/**
 * F20261027hwl1 模型效率报告 A 类测试：
 * - 日/周/月窗口从日级原始量重汇总（加权语义，非日均）
 * - 零分母 cache 率 = null（显「—」）
 * - provider unknown 独立桶
 * - 周窗口边界（Asia/Shanghai 周一起）
 * - collector：Shanghai 日界（UTC 16:00 后算次日）、provider 解析、model_change.provider 主源
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../helpers/db";
import { ModelEfficiencyReportBuilder } from "@usecases/health/model-efficiency-report";
import { shanghaiDateKey, resolveProvider } from "@usecases/health/session-date-provider";

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

function insertCostRow(date: string, key: string, value: number, meta: object): void {
  db.prepare(`
    INSERT INTO health_snapshots (snapshot_date, metric_type, metric_key, metric_value, metadata)
    VALUES (?, 'cost_output', ?, ?, ?)
  `).run(date, key, value, JSON.stringify(meta));
}

describe("日/周/月重汇总与零分母", () => {
  it("三窗口从日级原始量 SUM；cache 率按窗口内合计重算；零分母 null", async () => {
    // 10-25（上周六）+ 10-27（本周二）：today 固定 10-27（Shanghai）
    // 周一为 10-26 → 10-25 落在「月」不落「周」——验证窗口边界
    const meta = { model: "glm-5.3", provider: "zhipu" };
    insertCostRow("2026-10-25", "input_tokens", 100, meta);
    insertCostRow("2026-10-25", "cache_read_tokens", 100, meta);
    insertCostRow("2026-10-27", "input_tokens", 300, meta);
    insertCostRow("2026-10-27", "output_tokens", 100, meta);
    insertCostRow("2026-10-27", "cache_read_tokens", 100, meta);
    insertCostRow("2026-10-27", "llm_call_count", 2, meta);
    // 零分母模型：只有 output（input=0, cacheRead=0）
    const zeroMeta = { model: "edge-model", provider: "unknown" };
    insertCostRow("2026-10-27", "output_tokens", 50, zeroMeta);
    insertCostRow("2026-10-27", "llm_call_count", 1, zeroMeta);

    const builder = new ModelEfficiencyReportBuilder(
      { findByDateRange: (start: string, end: string) =>
          db.prepare("SELECT * FROM health_snapshots WHERE snapshot_date >= ? AND snapshot_date <= ?").all(start, end) as never },
      () => new Date("2026-10-27T20:00:00+08:00"), // Shanghai 周二晚
    );
    const report = await builder.build();

    expect(report.windows.week.start).toBe("2026-10-26");
    expect(report.windows.month.start).toBe("2026-10-01");
    expect(report.windows.day.start).toBe("2026-10-27");

    const glm = report.rows.find(r => r.model === "glm-5.3")!;
    expect(glm).toBeDefined();
    // 日窗口：input 300 + output 100 + cacheRead 100 = 500；率 100/(300+100)=0.25
    expect(glm.day!.totalTokens).toBe(500);
    expect(glm.day!.cacheHitRate).toBeCloseTo(0.25);
    // 周窗口（10-26 起，不含 10-25）：同日窗口
    expect(glm.week!.totalTokens).toBe(500);
    // 月窗口：10-25 也计入 → +200（input100+cacheRead100）= 700；率 200/(400+200)=1/3
    expect(glm.month!.totalTokens).toBe(700);
    expect(glm.month!.cacheHitRate).toBeCloseTo(1 / 3);

    // 零分母：显式 null（UI 显「—」），不是 0
    const edge = report.rows.find(r => r.model === "edge-model")!;
    expect(edge.day!.cacheHitRate).toBeNull();
    expect(edge.week!.cacheHitRate).toBeNull();

    // 合计行也参与重汇总
    expect(report.totals.day!.totalTokens).toBe(550);
  });

  it("provider 为空/脏 metadata 归 unknown 桶（不伪造）", async () => {
    insertCostRow("2026-10-27", "input_tokens", 10, { model: "mystery" }); // 无 provider
    const builder = new ModelEfficiencyReportBuilder(
      { findByDateRange: (start: string, end: string) =>
          db.prepare("SELECT * FROM health_snapshots WHERE snapshot_date >= ? AND snapshot_date <= ?").all(start, end) as never },
      () => new Date("2026-10-27T20:00:00+08:00"),
    );
    const report = await builder.build();
    const row = report.rows.find(r => r.provider === "unknown");
    expect(row).toBeDefined();
    // model 名保留（mystery），provider 归 unknown 桶
    expect(row!.model).toBe("mystery");
    expect(row!.day!.inputTokens).toBe(10);
  });
});

describe("Shanghai 日界与 provider 解析（collector 工具函数）", () => {
  it("UTC 16:00 后的调用归 Shanghai 次日（不再用 UTC 裸 slice）", () => {
    // 2026-10-27T17:30Z = Shanghai 10-28 01:30
    expect(shanghaiDateKey("2026-10-27T17:30:00.000Z")).toBe("2026-10-28");
    // 2026-10-27T07:00Z = Shanghai 10-27 15:00
    expect(shanghaiDateKey("2026-10-27T07:00:00.000Z")).toBe("2026-10-27");
    // 边界：UTC 15:59:59 = Shanghai 23:59:59（同日）
    expect(shanghaiDateKey("2026-10-27T15:59:59.000Z")).toBe("2026-10-27");
  });

  it("provider：原生字段优先；前缀可推断的推断；推不出 null", () => {
    expect(resolveProvider("anthropic", "anything")).toBe("anthropic");
    expect(resolveProvider(null, "glm-5.3")).toBe("zhipu");
    expect(resolveProvider(null, "kimi-k2")).toBe("moonshot");
    expect(resolveProvider(null, "mimo-v2.6-flash")).toBe("xiaomimimo");
    expect(resolveProvider(null, "claude-sonnet-4")).toBe("anthropic");
    expect(resolveProvider(null, "totally-unknown")).toBeNull();
  });
});
