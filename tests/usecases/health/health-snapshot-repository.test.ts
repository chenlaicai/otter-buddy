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
});
