/**
 * F20260805rsto：存量迁移 backfillSessionLedger 测试。
 * 覆盖：补登记缺失首世 / 幂等跳过 / dissolved 獭跳过 / 单条失败不阻塞。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { backfillSessionLedger } from "@frameworks/db/otter/backfill-session-ledger";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { createTestLogger } from "../../../helpers/logger";

function seedOtter(db: Database.Database, id: string, status = "active"): void {
  db.prepare(
    `INSERT INTO otters (id, name, type, status, created_at) VALUES (?, ?, 'big', ?, '2026-08-04T00:00:00Z')`,
  ).run(id, `獭-${id}`, status);
}

function seedAgentSession(db: Database.Database, otterId: string, createdAt?: string): void {
  db.prepare(
    `INSERT INTO agent_sessions (otter_id, pi_session_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(otterId, `pi-${otterId}`, createdAt ?? '2026-08-04 08:00:00', createdAt ?? '2026-08-04 08:00:00');
}

describe("backfillSessionLedger (F20260805rsto)", () => {
  let db: Database.Database;
  let repo: SqliteOtterRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    repo = new SqliteOtterRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("为「有 agent 会话、无 domain 行」的獭补登记首世 active session", async () => {
    seedOtter(db, "o1");
    seedAgentSession(db, "o1");

    await backfillSessionLedger(db, repo, createTestLogger());

    const session = await repo.getActiveSession("o1");
    expect(session).not.toBeNull();
    expect(session!.otterId).toBe("o1");
    expect(session!.previousSessionId).toBeNull();
    /** startedAt 取 agent 会话创建时刻作近似，而非补登记时刻 */
    expect(session!.startedAt).toBe("2026-08-04 08:00:00");
  });

  it("幂等：已有 active session 的獭跳过，不重复建行", async () => {
    seedOtter(db, "o1");
    seedAgentSession(db, "o1");

    await backfillSessionLedger(db, repo, createTestLogger());
    const first = await repo.getActiveSession("o1");
    await backfillSessionLedger(db, repo, createTestLogger());

    const history = await repo.getSessionHistory("o1");
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(first!.id);
  });

  it("dissolved 獭不补登记", async () => {
    seedOtter(db, "o1", "dissolved");
    seedAgentSession(db, "o1");

    await backfillSessionLedger(db, repo, createTestLogger());

    expect(await repo.getActiveSession("o1")).toBeNull();
  });

  it("agent_sessions 引用不存在的 otter 时告警跳过，其余照常补", async () => {
    seedOtter(db, "good");
    seedAgentSession(db, "good");
    // 孤儿行：绕过 FK 插入（模拟脏数据）
    db.pragma("foreign_keys = OFF");
    seedAgentSession(db, "ghost");
    db.pragma("foreign_keys = ON");

    await backfillSessionLedger(db, repo, createTestLogger());

    expect(await repo.getActiveSession("good")).not.toBeNull();
  });
});
