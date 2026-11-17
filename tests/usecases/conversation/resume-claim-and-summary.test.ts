import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { SqliteResumePendingRepository } from "@frameworks/db/conversation/sqlite-resume-pending-repository";
import { buildActionLedgerSummary } from "@usecases/execution/action-ledger-summary";
import type { ActionRecord } from "@entities/execution/action-record";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

/** F20261116actlg PR-B：认领绑定 claim token/boot epoch + 恢复摘要构造。 */
// lint-tests:allow-ddl —— 存量库迁移回归需手建 restart_pending_resumes 旧形态表（无 claim 四列）
// 验证 ALTER 补列幂等（被测对象就是「旧 schema → 新 schema」迁移本身，与 migration 测试同类）

function seedPending(db: Database.Database, invokeId = "inv-1", attempts = 0): void {
  db.prepare(
    "INSERT INTO restart_pending_resumes (invoke_id, conversation_id, otter_id, trigger_entry_id, status, attempts, created_at) VALUES (?, 'conv-1', 'otter-1', NULL, 'pending', ?, '2026-01-01T00:00:00Z')",
  ).run(invokeId, attempts);
}

describe("claim 认领绑定（token + boot epoch + pid）", () => {
  it("首次认领成功，写 token/epoch/pid", async () => {
    const db = createTestDb();
    seedPending(db);
    const repo = new SqliteResumePendingRepository(db);
    expect(await repo.claimPendingResume("inv-1", { token: "tok-a", bootEpoch: 100, pid: 4321 })).toBe(true);
    const row = await repo.getByInvokeId("inv-1");
    expect(row?.claimToken).toBe("tok-a");
    expect(row?.bootEpoch).toBe(100);
    expect(row?.claimPid).toBe(4321);
    expect(row?.attempts).toBe(1);
  });

  it("同 boot 内已认领拒重认领（防双窗口双跑）", async () => {
    const db = createTestDb();
    seedPending(db);
    const repo = new SqliteResumePendingRepository(db);
    expect(await repo.claimPendingResume("inv-1", { token: "tok-a", bootEpoch: 100, pid: 4321 })).toBe(true);
    expect(await repo.claimPendingResume("inv-1", { token: "tok-b", bootEpoch: 100, pid: 9999 })).toBe(false);
    const row = await repo.getByInvokeId("inv-1");
    expect(row?.claimToken).toBe("tok-a"); // 原持有者不变
    expect(row?.attempts).toBe(1);
  });

  it("旧纪元残留可被新开机重认领（恢复者崩溃不留死锁），attempts 继续累加，pid 更新为新持有者", async () => {
    const db = createTestDb();
    seedPending(db);
    const repo = new SqliteResumePendingRepository(db);
    expect(await repo.claimPendingResume("inv-1", { token: "tok-old", bootEpoch: 100, pid: 1111 })).toBe(true);
    // 模拟恢复者崩溃（行保持 pending、token/epoch/pid 残留）→ 新开机（epoch 999）重认领
    expect(await repo.claimPendingResume("inv-1", { token: "tok-new", bootEpoch: 999, pid: 2222 })).toBe(true);
    const row = await repo.getByInvokeId("inv-1");
    expect(row?.claimToken).toBe("tok-new");
    expect(row?.bootEpoch).toBe(999);
    expect(row?.claimPid).toBe(2222);
    expect(row?.attempts).toBe(2);
  });

  it("attempts 上限守卫不放松（含重认领路径）", async () => {
    const db = createTestDb();
    seedPending(db, "inv-max", 4); // 上限 5，只剩一次机会
    const repo = new SqliteResumePendingRepository(db);
    expect(await repo.claimPendingResume("inv-max", { token: "t1", bootEpoch: 1, pid: 1 })).toBe(true); // attempts=5
    expect(await repo.claimPendingResume("inv-max", { token: "t2", bootEpoch: 2, pid: 2 })).toBe(false); // 旧纪元重认领也被上限挡住
  });

  it("审计链追加式：多次恢复全历史不丢（S2）", async () => {
    const db = createTestDb();
    seedPending(db);
    const repo = new SqliteResumePendingRepository(db);
    await repo.appendRecoveryInvoke("inv-1", "recovery-inv-1");
    expect((await repo.getByInvokeId("inv-1"))?.recoveryInvokeId).toBe("recovery-inv-1"); // 首次为单值
    await repo.appendRecoveryInvoke("inv-1", "recovery-inv-2");
    expect((await repo.getByInvokeId("inv-1"))?.recoveryInvokeId).toBe("recovery-inv-1,recovery-inv-2"); // 追加不覆盖
  });

  it("持有校验 settle：持有者可收口、他人不覆盖、无主行可兜底（S1）", async () => {
    const db = createTestDb();
    seedPending(db);
    const repo = new SqliteResumePendingRepository(db);
    expect(await repo.claimPendingResume("inv-1", { token: "tok-a", bootEpoch: 100, pid: 4321 })).toBe(true);
    // 他人 token 不覆盖（行被 tok-a 持有）
    expect(await repo.settleResumeHeld("inv-1", "tok-b", "exhausted", "2026-01-02T00:00:00Z")).toBe(false);
    expect((await repo.getByInvokeId("inv-1"))?.status).toBe("pending");
    // 持有者收口成功
    expect(await repo.settleResumeHeld("inv-1", "tok-a", "done", "2026-01-02T00:00:00Z")).toBe(true);
    expect((await repo.getByInvokeId("inv-1"))?.status).toBe("done");
    // 无主行（从未认领）可被兜底 settle（存量库迁移行兼容）
    seedPending(db, "inv-orphan");
    expect(await repo.settleResumeHeld("inv-orphan", "any-token", "exhausted", "2026-01-02T00:00:00Z")).toBe(true);
    expect((await repo.getByInvokeId("inv-orphan"))?.status).toBe("exhausted");
  });
});

describe("buildActionLedgerSummary 恢复摘要", () => {
  function row(overrides: Partial<ActionRecord>): ActionRecord {
    return {
      actionId: "a", deviceId: "local", onlineSessionId: null, invokeId: "inv", conversationId: null,
      toolCallId: null, source: "sdk-env", kind: "file.write", target: "/tmp/x", contentHash: null,
      contentBytes: null, status: "succeeded", error: null, resultSummary: null, bootEpoch: 1,
      pid: null, startedAt: "2026-01-01T00:00:00Z", settledAt: null, ...overrides,
    };
  }

  it("unknown 排最前（需检查优先），含各状态计数与处置指引", () => {
    const summary = buildActionLedgerSummary([
      row({ status: "succeeded", kind: "file.write", target: "/data/a.md" }),
      row({ status: "unknown", kind: "shell.exec", target: "npm run build" }),
      row({ status: "interrupted", kind: "workspace.write", target: "/ws/b.md" }),
    ]);
    expect(summary).not.toBeNull();
    expect(summary!).toContain("unknown×1、interrupted×1、succeeded×1");
    expect(summary!.indexOf("[unknown] shell.exec")).toBeLessThan(summary!.indexOf("[succeeded] file.write"));
    expect(summary!).toContain("npm run build");
    expect(summary!).toContain("禁止盲目重试");
    expect(summary!).toContain("可安全重做");
  });

  it("空行返回 null（无摘要，恢复文案退回旧版）", () => {
    expect(buildActionLedgerSummary([])).toBeNull();
  });

  it("超过上限折叠为「另有 N 项」", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ actionId: `a${i}`, status: "succeeded", target: `/f/${i}` }));
    const summary = buildActionLedgerSummary(rows)!;
    expect(summary).toContain("另有 5 项");
    expect(summary.split("\n").filter(l => l.startsWith("- [")).length).toBe(20);
  });
});

describe("存量库迁移（claim 四列 ALTER）", () => {
  it("旧形态表补四列，幂等可重跑", async () => {
    const db = createTestDb();
    db.exec("DROP TABLE restart_pending_resumes");
    db.exec(`
      CREATE TABLE restart_pending_resumes (
        invoke_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        otter_id TEXT NOT NULL,
        trigger_entry_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        settled_at TEXT
      );
    `);
    const { migrateDatabase } = await import("@frameworks/db/migration");
    migrateDatabase(db, createTestLogger());
    migrateDatabase(db, createTestLogger()); // 幂等重跑
    const columns = (db.prepare("PRAGMA table_info(restart_pending_resumes)").all() as Array<{ name: string }>).map(c => c.name);
    expect(columns).toContain("claim_token");
    expect(columns).toContain("boot_epoch");
    expect(columns).toContain("claim_pid");
    expect(columns).toContain("recovery_invoke_id");
  });
});
