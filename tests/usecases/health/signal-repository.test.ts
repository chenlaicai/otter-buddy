import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { SignalRepository } from "@usecases/health/signal-repository";

/** 真 SQLite 验证 signals 表 upsert/occurrences/resolve 语义 */
describe("SignalRepository（真 sqlite）", () => {
  function makeRepo(): SignalRepository {
    const db = new Database(":memory:");
    initSchema(db);
    migrateDatabase(db, console as never);
    return new SignalRepository(db);
  }

  const baseSignal = {
    signalType: "bug_recurrence",
    severity: "critical",
    featureId: null,
    filePath: "src/invoker.ts",
    evidence: "agent invoker 3 次",
    suggestedAction: "强制根因分析",
  };

  it("首次 upsert 新开一行，occurrences=1", () => {
    const repo = makeRepo();
    const r = repo.upsert(baseSignal);
    expect(r.occurrences).toBe(1);
    expect(r.status).toBe("open");
    expect(r.id).toBeTruthy();
  });

  it("重复触发同键信号：occurrences 累加而非新行", () => {
    const repo = makeRepo();
    repo.upsert(baseSignal);
    const r2 = repo.upsert({ ...baseSignal, evidence: "agent invoker 4 次" });
    expect(r2.occurrences).toBe(2);
    expect(repo.findOpen()).toHaveLength(1);
    expect(r2.evidence).toBe("agent invoker 4 次"); // evidence 刷新为最新
  });

  it("不同 file_path 是不同信号（键 = type+feature+file）", () => {
    const repo = makeRepo();
    repo.upsert(baseSignal);
    repo.upsert({ ...baseSignal, filePath: "src/other.ts" });
    expect(repo.findOpen()).toHaveLength(2);
  });

  it("resolved 后同键再触发新开一行（历史保留）", () => {
    const repo = makeRepo();
    const r1 = repo.upsert(baseSignal);
    repo.resolve(r1.id);
    const r2 = repo.upsert(baseSignal);
    expect(r2.id).not.toBe(r1.id);
    expect(repo.findOpen()).toHaveLength(1);
    expect(repo.findByStatus("resolved")).toHaveLength(1);
  });

  it("resolve/dismiss 只作用于 open 状态", () => {
    const repo = makeRepo();
    const r = repo.upsert(baseSignal);
    expect(repo.resolve(r.id)).toBe(true);
    expect(repo.resolve(r.id)).toBe(false); // 已 resolved
    const r2 = repo.upsert({ ...baseSignal, filePath: "x.ts" });
    expect(repo.dismiss(r2.id)).toBe(true);
    expect(repo.dismiss(r2.id)).toBe(false);
  });

  it("purgeClosed 清理过期已关闭信号，open 不受影响", () => {
    const repo = makeRepo();
    const r = repo.upsert(baseSignal);
    repo.resolve(r.id, new Date("2026-01-01T00:00:00Z")); // 很久以前
    repo.upsert({ ...baseSignal, filePath: "keep.ts" }); // open

    expect(repo.purgeClosed(30)).toBe(1);
    expect(repo.findByStatus("resolved")).toHaveLength(0);
    expect(repo.findOpen()).toHaveLength(1);
  });

  it("featureId null 与字符串互不混淆（COALESCE 键匹配）", () => {
    const repo = makeRepo();
    repo.upsert({ ...baseSignal, featureId: null });
    repo.upsert({ ...baseSignal, featureId: "F20260801tstw" });
    repo.upsert({ ...baseSignal, featureId: "F20260801tstw" }); // 同键累加
    expect(repo.findOpen()).toHaveLength(2);
    expect(repo.findOpen().find(s => s.feature_id === "F20260801tstw")?.occurrences).toBe(2);
  });
});
