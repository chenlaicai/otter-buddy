import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";

/** 真 SQLite 验证 health_snapshots 的 DELETE+INSERT 同日覆盖语义 */
describe("HealthSnapshotRepository（真 sqlite）", () => {
  function makeRepo(): { repo: HealthSnapshotRepository; db: Database.Database } {
    const db = new Database(":memory:");
    initSchema(db);
    return { repo: new HealthSnapshotRepository(db), db };
  }

  const day = "2026-08-25";
  const rows = (date: string, value: number) => [
    { snapshotDate: date, metricType: "overview", metricKey: "bugfix_ratio", metricValue: value },
    { snapshotDate: date, metricType: "overview", metricKey: "total_commits", metricValue: value * 100 },
  ];

  it("createBatch 事务写入，findByDate 读回", () => {
    const { repo, db } = makeRepo();
    repo.createBatch(rows(day, 0.21));

    const found = repo.findByDate(day);
    expect(found).toHaveLength(2);
    expect(found.map(s => s.metric_key)).toContain("bugfix_ratio");
    db.close();
  });

  it("replaceForDate：同日重复运行覆盖，findByDate 恒返回最新（对抗审视发现 4）", () => {
    const { repo, db } = makeRepo();
    repo.replaceForDate(day, rows(day, 0.21));
    repo.replaceForDate(day, rows(day, 0.27));

    const found = repo.findByDate(day);
    expect(found).toHaveLength(2); // 仍是 2 条，不是 4 条
    expect(found.find(s => s.metric_key === "bugfix_ratio")?.metric_value).toBe(0.27);
    db.close();
  });

  it("replaceForDate 跨日不覆盖", () => {
    const { repo, db } = makeRepo();
    repo.replaceForDate("2026-08-24", rows("2026-08-24", 0.2));
    repo.replaceForDate(day, rows(day, 0.27));

    expect(repo.findByDate("2026-08-24")).toHaveLength(2);
    expect(repo.findByDate(day)).toHaveLength(2);
    db.close();
  });

  it("findLatestByMetricKey 取最新日期", () => {
    const { repo, db } = makeRepo();
    repo.replaceForDate("2026-08-24", rows("2026-08-24", 0.2));
    repo.replaceForDate(day, rows(day, 0.27));

    const latest = repo.findLatestByMetricKey("bugfix_ratio");
    expect(latest?.metric_value).toBe(0.27);
    db.close();
  });

  it("deleteOlderThan 保留策略", () => {
    const { repo, db } = makeRepo();
    repo.replaceForDate("2026-01-01", rows("2026-01-01", 0.1));
    repo.replaceForDate(day, rows(day, 0.27));

    expect(repo.deleteOlderThan(90)).toBe(2); // 1/1 距今 >90 天，删 2 行
    expect(repo.findByDate("2026-01-01")).toHaveLength(0);
    expect(repo.findByDate(day)).toHaveLength(2);
    db.close();
  });

  it("replaceForDate(metricType) 只删除指定类型的行，不影响其他类型（#583 S1 修复）", () => {
    const { repo, db } = makeRepo();

    // 写入 overview 行
    repo.replaceForDate(day, rows(day, 0.21));
    expect(repo.findByDate(day)).toHaveLength(2);

    // 写入 cost_output 行（指定 metricType）
    const costRows = [
      { snapshotDate: day, metricType: "cost_output", metricKey: "input_tokens", metricValue: 1000 },
      { snapshotDate: day, metricType: "cost_output", metricKey: "cost_total", metricValue: 0.01 },
    ];
    repo.replaceForDate(day, costRows, "cost_output");

    // overview 行应保留，cost_output 行应写入
    const allRows = repo.findByDate(day);
    expect(allRows).toHaveLength(4); // 2 overview + 2 cost_output

    // 再次写入 cost_output 行（应只替换 cost_output，不删 overview）
    const costRows2 = [
      { snapshotDate: day, metricType: "cost_output", metricKey: "input_tokens", metricValue: 2000 },
    ];
    repo.replaceForDate(day, costRows2, "cost_output");

    const allRows2 = repo.findByDate(day);
    expect(allRows2).toHaveLength(3); // 2 overview + 1 cost_output
    expect(allRows2.filter(r => r.metric_type === "overview")).toHaveLength(2);
    expect(allRows2.find(r => r.metric_type === "cost_output")?.metric_value).toBe(2000);

    db.close();
  });
});
