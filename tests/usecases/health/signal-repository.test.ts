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

describe("Issue #644：evidence_detail + confidence 列", () => {
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

  // 旧形状 signals 表（8/31 存量库：无 evidence_detail/confidence 列）
  // lint-tests:allow-ddl（迁移测试需建旧 schema 表，与 migration 同类豁免，见 scripts/lint-tests.mjs 5→6 注记）
  const OLD_SIGNALS_DDL = `
    CREATE TABLE signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type TEXT NOT NULL, severity TEXT NOT NULL,
      feature_id TEXT, file_path TEXT, evidence TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      occurrences INTEGER DEFAULT 1, status TEXT DEFAULT 'open',
      suggested_action TEXT, created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT
    )`;

  it("首次 upsert 落 detail 与 confidence", () => {
    const repo = makeRepo();
    const r = repo.upsert({
      ...baseSignal,
      evidenceDetail: { kind: "bug_recurrence_commits", windowDays: 30, commits: [{ sha: "abc12345", date: "2026-09-01T00:00:00Z", changeType: "BugFix", message: "x" }] },
      confidence: "low",
    });
    expect(r.evidence_detail).toContain("bug_recurrence_commits");
    expect(r.confidence).toBe("low");
    // 落库可查
    const open = repo.findOpen();
    expect(open[0]!.evidence_detail).toContain("abc12345");
    expect(open[0]!.confidence).toBe("low");
  });

  it("UPDATE 分支同步刷新 detail/confidence（存量信号置信分层不卡死，合议审读 §3.1）", () => {
    const repo = makeRepo();
    repo.upsert(baseSignal); // 首次无 detail/confidence（模拟存量）
    const r = repo.upsert({
      ...baseSignal,
      evidenceDetail: { kind: "bug_recurrence_commits", windowDays: 30, commits: [] },
      confidence: "low",
    });
    expect(r.occurrences).toBe(2);
    expect(r.confidence).toBe("low");
    expect(r.evidence_detail).toContain("bug_recurrence_commits");
    const open = repo.findOpen();
    expect(open[0]!.confidence).toBe("low");
  });

  it("未传 detail/confidence 时不覆盖已有值（COALESCE 语义）", () => {
    const repo = makeRepo();
    repo.upsert({ ...baseSignal, confidence: "low", evidenceDetail: { kind: "x", commits: [{ sha: "aa" }] } });
    const r = repo.upsert({ ...baseSignal }); // 旧行为调用方
    expect(r.confidence).toBe("low"); // 保留
    expect(r.evidence_detail).toContain("\"sha\":\"aa\""); // 保留
    // 审视建议发现 2：以上断言读的是 TS 拼装返回值（coalesceExisting），与 SQL 的
    // COALESCE(?, col) 是两套逻辑——若 SQL 误写直接覆盖，上面仍绿。此处补 findOpen
    // 读 DB 实态，把 UPDATE 的 SQL 侧 COALESCE 行为也锁住
    const open = repo.findOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.confidence).toBe("low");
    expect(open[0]!.evidence_detail).toContain("\"sha\":\"aa\"");
  });

  it("存量库补列迁移：老库（无新列）跑 migrateDatabase 后两列可用", () => {
    // 模拟 8/31 存量库：先建旧形状 signals 表，再 initSchema 补齐其余表
    //（CREATE IF NOT EXISTS 对已存在的 signals 是 no-op，旧表结构保留），
    // 然后 migrateDatabase 应 ALTER 补两列
    const db = new Database(":memory:");
    db.exec(OLD_SIGNALS_DDL);
    initSchema(db);
    migrateDatabase(db, console as never);
    const cols = db.prepare("PRAGMA table_info(signals)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === "evidence_detail")).toBe(true);
    expect(cols.some(c => c.name === "confidence")).toBe(true);
    // 幂等：再跑一遍不炸不重复加列
    migrateDatabase(db, console as never);
    const cols2 = db.prepare("PRAGMA table_info(signals)").all() as Array<{ name: string }>;
    expect(cols2.filter(c => c.name === "confidence")).toHaveLength(1);
    // 补列后 upsert 全链路可用
    const repo = new SignalRepository(db);
    const r = repo.upsert({ ...baseSignal, confidence: "low" });
    expect(r.confidence).toBe("low");
  });
});

describe("Issue #645 审视 S1：severity/suggested_action 档位推进（僵尸阶梯）", () => {
  function makeRepo(): SignalRepository {
    const db = new Database(":memory:");
    initSchema(db);
    migrateDatabase(db, console as never);
    return new SignalRepository(db);
  }
  const base = {
    signalType: "chain_stall",
    severity: "warning" as const,
    featureId: "F20260801stal" as string | null,
    filePath: "docs/features/2026/08/01/F20260801stal.md" as string | null,
    evidence: "链 35 天黄档",
    suggestedAction: "观察或链复盘：确认是暂停还是废弃",
  };

  it("同键信号档位推进：UPDATE 刷新 severity 与 suggested_action（黄档→红档不冻结）", () => {
    const repo = makeRepo();
    // 黄档 35 天首开：warning
    repo.upsert({ ...base });
    // 推进到红档 65 天：critical 再触发，severity/suggested_action 必须随 evidence 一起推进
    const r2 = repo.upsert({
      ...base, severity: "critical",
      evidence: "链 65 天红档", suggestedAction: "强制链复盘：90 天内归档或重启",
    });
    expect(r2.severity).toBe("critical");
    expect(r2.suggested_action).toBe("强制链复盘：90 天内归档或重启");
    expect(r2.occurrences).toBe(2);
    // DB 实态同步验证（不只信 TS 拼装返回值，同 #644 发现 2 的教训）
    const open = repo.findOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.severity).toBe("critical");
    expect(open[0]!.suggested_action).toBe("强制链复盘：90 天内归档或重启");
    expect(open[0]!.evidence).toBe("链 65 天红档");
  });

  it("suggestedAction 传 null 时不覆盖已有值（COALESCE 防御语义）", () => {
    const repo = makeRepo();
    repo.upsert({ ...base });
    const r2 = repo.upsert({ ...base, suggestedAction: null });
    expect(r2.suggested_action).toBe("观察或链复盘：确认是暂停还是废弃"); // 保留首开的值
    expect(repo.findOpen()[0]!.suggested_action).toBe("观察或链复盘：确认是暂停还是废弃");
  });
});
