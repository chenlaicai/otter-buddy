/**
 * F20260916b1ea reconcile 入队测试：postInitDatabase 的 failRunningInvokes + 入队逻辑。
 *
 * 验证：running invoke → failed + pending 入队；trigger_entry_id 为 NULL 的
 * scheduler 来源 invoke 不入队（A3 处置）；trigger entry 为 system 的 invoke 不入队；
 * 幂等（重复启动不重复入队）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initRepositories } from "../../src/bootstrap/repositories";
import type { Repositories } from "../../src/bootstrap/types";
import { postInitDatabase } from "../../src/bootstrap/database";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";

const T0 = "2026-01-01T00:00:00Z";

describe("postInitDatabase 重启 reconcile 入队（F20260916b1ea）", () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = createTestDb();
    repos = initRepositories(db, createTestLogger());
    db.prepare("INSERT INTO otters (id, name, type, created_at) VALUES ('otter-1', '獭一', 'big', ?)").run(T0);
    db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', '测试', 'active', ?, ?)").run(T0, T0);
    db.prepare("INSERT INTO turns (id, conversation_id, turn_number, status, created_at) VALUES ('turn-1', 'conv-1', 1, 'open', ?)").run(T0);
  });

  afterEach(() => {
    db.close();
  });

  function insertEntry(id: string, entryType: string, opts: { yieldTargets?: string | null; createdAt?: string } = {}): void {
    db.prepare(`
      INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, invoke_id, yield_targets, turn_id, status, sender_name, created_at, completed_at)
      VALUES (?, 'conv-1', 1, ?, 'user', 'chen', '内容', NULL, ?, 'turn-1', 'completed', '搭档', ?, ?)
    `).run(id, entryType, opts.yieldTargets ?? null, opts.createdAt ?? T0, opts.createdAt ?? T0);
  }

  function insertRunningInvoke(id: string, triggerEntryId: string | null): void {
    db.prepare(`
      INSERT INTO invokes (id, conversation_id, otter_id, status, trigger_entry_id, started_at)
      VALUES (?, 'conv-1', 'otter-1', 'running', ?, ?)
    `).run(id, triggerEntryId, T0);
  }

  function queueRows(): Array<{ invoke_id: string; status: string; trigger_entry_id: string | null }> {
    return db.prepare("SELECT invoke_id, status, trigger_entry_id FROM restart_pending_resumes").all() as Array<{ invoke_id: string; status: string; trigger_entry_id: string | null }>;
  }

  it("running invoke（user entry 触发）→ failed + pending 入队", async () => {
    const entryId = "entry-user-1";
    insertEntry(entryId, "user", { yieldTargets: '["otter-1"]' });
    insertRunningInvoke("invoke-1", entryId);

    await postInitDatabase(db, repos, createTestLogger());

    const invoke = db.prepare("SELECT status FROM invokes WHERE id = 'invoke-1'").get() as { status: string };
    expect(invoke.status).toBe("failed");
    const rows = queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoke_id: "invoke-1", status: "pending" });
  });

  it("scheduler 来源 invoke（trigger_entry_id 为 NULL）同样入队（F20260917rscr 裁决①）", async () => {
    insertRunningInvoke("invoke-null", null);

    await postInitDatabase(db, repos, createTestLogger());

    const invoke = db.prepare("SELECT status FROM invokes WHERE id = 'invoke-null'").get() as { status: string };
    expect(invoke.status).toBe("failed");
    const rows = queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoke_id: "invoke-null", status: "pending" });
    expect(rows[0]!.trigger_entry_id).toBeNull();
  });

  it("scheduler 来源 invoke（trigger entry 为 system）同样入队（F20260917rscr 裁决①）", async () => {
    const sysEntryId = "entry-sys-1";
    insertEntry(sysEntryId, "system");
    insertRunningInvoke("invoke-sys", sysEntryId);

    await postInitDatabase(db, repos, createTestLogger());

    const rows = queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoke_id: "invoke-sys", status: "pending" });
  });

  it("无 running invoke：空转零副作用", async () => {
    await postInitDatabase(db, repos, createTestLogger());
    expect(queueRows()).toHaveLength(0);
  });

  it("幂等：中断 invoke 重复 reconcile 不重复入队（INSERT OR IGNORE）", async () => {
    const entryId = "entry-user-2";
    insertEntry(entryId, "user", { yieldTargets: '["otter-1"]' });
    insertRunningInvoke("invoke-2", entryId);

    await postInitDatabase(db, repos, createTestLogger());
    // 模拟恢复流程未完成又重启：invoke 已 failed，手动把队列置回 pending（crash-resilience 场景）
    db.prepare("UPDATE restart_pending_resumes SET status = 'pending' WHERE invoke_id = 'invoke-2'").run();
    // 再次启动：无 running invoke，入队逻辑空转
    await postInitDatabase(db, repos, createTestLogger());

    expect(queueRows()).toHaveLength(1);
    expect(queueRows()[0]).toMatchObject({ invoke_id: "invoke-2", status: "pending" });
  });
});
