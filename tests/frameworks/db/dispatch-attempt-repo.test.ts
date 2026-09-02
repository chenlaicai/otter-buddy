// lint-tests:allow-ddl —— 真实仓储集成测试：手工 seed 消息/獭数据（rbsg 教训——mock 与真实投影的分歧两次酿祸）
/**
 * F20260902sgp2 S1：派发台账真实仓储集成测试。
 * 三条事故回放判据（设计 §2）+ 记账全链路 + 幂等性 + 死亡证明/墓碑。
 * 全部走 SQLite 真库真投影，禁 mock 判据路径。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteDispatchAttemptRepo } from "@frameworks/db/conversation/sqlite-dispatch-attempt-repo";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

/** seed 一条已投递消息（talkingStonePassedTo JSON 列，模拟真实投影格式） */
function seedDelivered(
  db: Database.Database,
  id: string,
  opts: {
    targets?: string[] | null;
    senderType?: string;
    senderId?: string;
    status?: string;
    conversationId?: string;
    createdAt?: string;
  } = {},
): void {
  const convId = opts.conversationId ?? "conv-1";
  const turnId = `turn-${convId}`;
  db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, 't', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run(convId);
  db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES (?, ?, 1, '2026-09-02T00:00:00Z')`).run(turnId, convId);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id, convId,
    opts.senderType ?? "user",
    opts.senderId ?? "user",
    opts.status ?? "completed",
    turnId,
    opts.targets ? JSON.stringify(opts.targets) : null,
    opts.createdAt ?? "2026-09-02T09:00:00Z",
  );
}

function seedOtter(db: Database.Database, id: string): void {
  db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, created_at) VALUES (?, ?, 'big', '2026-09-02T00:00:00Z')`).run(id, `otter-${id}`);
}

describe("SqliteDispatchAttemptRepo（sgp2 S1 真实仓储集成）", () => {
  let db: Database.Database;
  let repo: SqliteDispatchAttemptRepo;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteDispatchAttemptRepo(db);
    seedOtter(db, "otter-1");
    seedOtter(db, "otter-2");
  });

  afterEach(() => {
    db.close();
  });

  describe("pending 判据（§4.3 SQL）", () => {
    it("R1 崩溃窗口：已投递未记账 = pending，计数可见", () => {
      seedDelivered(db, "msg-crash", { targets: ["otter-1"] });
      expect(repo.countPendingSignals("conv-1")).toBe(1);
      const rows = repo.listPendingSignals("conv-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].messageId).toBe("msg-crash");
      expect(rows[0].targetOtterId).toBe("otter-1");
    });

    it("R2 前置：多獭稳态滞后的历史消息在墓碑后零 pending", () => {
      seedDelivered(db, "msg-stale", { targets: ["otter-1", "otter-2"] });
      const n = repo.backfillLegacyAttempted();
      expect(n).toBe(2); // 两条 (message, target) 均翻篇
      expect(repo.countPendingSignals("conv-1")).toBe(0);
    });

    it("R3：failed 记账后不重燃（债务不永存）", () => {
      seedDelivered(db, "msg-fail", { targets: ["otter-1"] });
      repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-fail", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:01Z", note: null });
      repo.recordFinish("msg-fail", "otter-1", "failed", "tool timeout");
      expect(repo.countPendingSignals("conv-1")).toBe(0);
    });

    it("非信号消息不进 pending：system / 无目标 / user 目标 / 自指 / 非 completed", () => {
      seedDelivered(db, "m-sys", { senderType: "system", targets: ["otter-1"] });
      seedDelivered(db, "m-none", { targets: null });
      seedDelivered(db, "m-user", { targets: ["user"] });
      seedDelivered(db, "m-self", { senderType: "otter", senderId: "otter-1", targets: ["otter-1"] });
      seedDelivered(db, "m-stream", { status: "streaming", targets: ["otter-1"] });
      expect(repo.countPendingSignals("conv-1")).toBe(0);
    });

    it("归档会话不扫（c.status=active 过滤）", () => {
      seedDelivered(db, "m-arch", { targets: ["otter-1"], conversationId: "conv-arch" });
      db.prepare(`UPDATE conversations SET status = 'archived' WHERE id = 'conv-arch'`).run();
      expect(repo.countPendingSignals("conv-arch")).toBe(0);
    });

    it("指向不存在獭的目标不进 pending（EXISTS otters 守卫）", () => {
      seedDelivered(db, "m-ghost", { targets: ["otter-ghost"] });
      expect(repo.countPendingSignals("conv-1")).toBe(0);
    });
  });

  describe("记账链路（§4.2 链引擎插桩契约）", () => {
    it("recordStart → in_progress；recordFinish → 终态；覆盖式 retry 压缩前情进 note（§8.2）", () => {
      seedDelivered(db, "msg-1", { targets: ["otter-1"] });
      repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-1", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:01Z", note: null });
      repo.recordFinish("msg-1", "otter-1", "failed", "tool timeout");
      // 用户手动 retry：覆盖同槽，前情压缩进 note
      repo.recordStart({ id: "a2", conversationId: "conv-1", messageId: "msg-1", targetOtterId: "otter-1", status: "in_progress", source: "retry", attemptStartedAt: "2026-09-02T09:05:00Z", note: null });
      const row = db.prepare(`SELECT status, source, note FROM dispatch_attempts WHERE message_id = 'msg-1' AND target_otter_id = 'otter-1'`).get() as { status: string; source: string; note: string | null };
      expect(row.status).toBe("in_progress");
      expect(row.source).toBe("retry");
      expect(row.note).toContain("prev=failed");
      expect(row.note).toContain("tool timeout");
      // retry 起跑后仍非 pending（一尝试一销账）
      expect(repo.countPendingSignals("conv-1")).toBe(0);
    });

    it("in_progress 即非 pending（起跑即销账）", () => {
      seedDelivered(db, "msg-2", { targets: ["otter-1"] });
      repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-2", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:01Z", note: null });
      expect(repo.countPendingSignals("conv-1")).toBe(0);
    });
  });

  describe("启动任务（§4.4/§4.5）", () => {
    it("死亡证明：stale in_progress 一律标 failed + note", () => {
      seedDelivered(db, "msg-3", { targets: ["otter-1"] });
      repo.recordStart({ id: "a1", conversationId: "conv-1", messageId: "msg-3", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:01Z", note: null });
      const n = repo.markStaleInProgressFailed();
      expect(n).toBe(1);
      const row = db.prepare(`SELECT status, note FROM dispatch_attempts WHERE message_id = 'msg-3'`).get() as { status: string; note: string | null };
      expect(row.status).toBe("failed");
      expect(row.note).toContain("进程重启");
      // 翻篇后非 pending——补扫不点火
      expect(repo.countPendingSignals("conv-1")).toBe(0);
    });

    it("墓碑幂等：backfill 两次第二次零新增；已有真实记录的槽位不被墓碑覆盖", () => {
      seedDelivered(db, "msg-4", { targets: ["otter-1"] });
      // otter-1 已有真实 in_progress 记录（OR IGNORE 跳过）
      repo.recordStart({ id: "real", conversationId: "conv-1", messageId: "msg-4", targetOtterId: "otter-1", status: "in_progress", source: "chain", attemptStartedAt: "2026-09-02T09:00:01Z", note: null });
      const n1 = repo.backfillLegacyAttempted();
      expect(n1).toBe(0); // 唯一槽位被真实记录占住
      const row = db.prepare(`SELECT source FROM dispatch_attempts WHERE message_id = 'msg-4'`).get() as { source: string };
      expect(row.source).toBe("chain"); // 未被 backfill 覆盖
      const n2 = repo.backfillLegacyAttempted();
      expect(n2).toBe(0);
    });
  });
});
