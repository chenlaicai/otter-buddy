/**
 * F20260929czi0：进场游标零点修正存量迁移测试（db 迁移三不变量）。
 *
 * 迁移语义：active 参与者 × active 对话 × last_read_seq=0 → 该对话 max(seq)。
 * 零游标是 F20260913ctlv 口径的事故值（零游标獭把全历史当未读，多为换世后
 * 爆窗锁死——pushCursorOnStartup 只在启动成功时推进游标，爆窗 400 → 不推进 →
 * 永远全量未读），事实状态就是「读到最新」，与 #775 backfillLastReadSeq 同源。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Entry } from "@entities/conversation/entry";
import type { Conversation } from "@entities/conversation/conversation";
import { createTestDb } from "../../../helpers/db";

function convFixture(id: string): Conversation {
  return {
    id, title: `t-${id}`, status: "active", summary: null, pinned: false, kind: "normal", workspaceDir: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null, archivedAt: null,
  };
}

describe("存量零游标迁移（F20260929czi0）", () => {
  let db: Database.Database;
  let entryRepo: SqliteEntryRepository;
  let convRepo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    entryRepo = new SqliteEntryRepository(db);
    convRepo = new SqliteConversationRepository(db);
    convRepo.create(convFixture("conv-1"));
    // 真归档对话（弱状态：archived 为终态）——迁移只动 active 对话的参与者
    convRepo.create({ ...convFixture("conv-archived"), status: "archived" });
    db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-2','t2','active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('zero-1','零游标獭','small','active','2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('read-1','已读獭','small','active','2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('left-1','退场獭','small','active','2026-01-01T00:00:00Z')").run();
  });

  afterEach(() => { db.close(); });

  let fixtureSeq = 0;
  function entryFixture(conversationId: string, body: string): Entry {
    fixtureSeq += 1;
    return {
      id: `entry-${fixtureSeq}`, conversationId, sequenceNum: 0, entryType: "speak",
      senderType: "otter", senderId: "big-1", body, invokeId: null, yieldTargets: null, status: "completed", source: null, metadata: null,
      senderName: "x", contextTokens: null, contextTokensMax: null,
      createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
    };
  }

  async function seed(): Promise<{ conv1Max: number }> {
    const e1 = await entryRepo.createEntryAtomic(entryFixture("conv-1", "消息1"));
    const e2 = await entryRepo.createEntryAtomic(entryFixture("conv-1", "消息2"));
    return { conv1Max: Math.max(e1.sequenceNum, e2.sequenceNum) };
  }

  it("零游标 active×active 獭被推进到 max(seq)，迁移后未读为空", async () => {
    const { conv1Max } = await seed();
    db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p1','conv-1','zero-1','active','2026-01-01T00:00:00Z',0)").run();

    const changes = convRepo.advanceZeroCursorsForActiveJoin();

    expect(changes).toBe(1);
    const row = db.prepare("SELECT last_read_seq FROM conversation_participants WHERE otter_id = 'zero-1'").get() as { last_read_seq: number };
    expect(row.last_read_seq).toBe(conv1Max);
    // 迁移后未读为空——不再被全历史灌爆
    const unread = await entryRepo.getUnreadEntries("conv-1", "zero-1");
    expect(unread).toEqual([]);
  });

  it("left 参与者、归档对话、非零游标、NULL 游标均不动", async () => {
    await seed();
    db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq, left_at) VALUES ('p2','conv-1','left-1','left','2026-01-01T00:00:00Z',0,'2026-01-02T00:00:00Z')").run();
    db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p3','conv-archived','zero-1','active','2026-01-01T00:00:00Z',0)").run();
    db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p4','conv-1','read-1','active','2026-01-01T00:00:00Z',1)").run();
    db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p5','conv-2','read-1','active','2026-01-01T00:00:00Z',NULL)").run();

    const changes = convRepo.advanceZeroCursorsForActiveJoin();

    expect(changes).toBe(0);
    const rows = db.prepare("SELECT id, last_read_seq FROM conversation_participants").all() as Array<{ id: string; last_read_seq: number | null }>;
    const byId = new Map(rows.map(r => [r.id, r.last_read_seq]));
    expect(byId.get("p2")).toBe(0);
    expect(byId.get("p3")).toBe(0);
    expect(byId.get("p4")).toBe(1);
    expect(byId.get("p5")).toBeNull();
  });

  it("幂等：二次执行零改动（返回 0）", async () => {
    await seed();
    db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p6','conv-1','zero-1','active','2026-01-01T00:00:00Z',0)").run();
    const first = convRepo.advanceZeroCursorsForActiveJoin();
    const second = convRepo.advanceZeroCursorsForActiveJoin();
    const third = convRepo.advanceZeroCursorsForActiveJoin();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(third).toBe(0);
  });

  it("空对话（max(seq)=0）幂等安全：迁移前后等价", async () => {
    db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p7','conv-2','zero-1','active','2026-01-01T00:00:00Z',0)").run();

    const changes = convRepo.advanceZeroCursorsForActiveJoin();

    // 空对话 max(seq)=0：迁移写 0 与原值等价——视为已处理（changed）但值不变
    expect(changes).toBe(1);
    const row = db.prepare("SELECT last_read_seq FROM conversation_participants WHERE id = 'p7'").get() as { last_read_seq: number };
    expect(row.last_read_seq).toBe(0);
    // 二次执行：仍为 0 游标 → 仍命中 WHERE，changes=1 但值恒 0（语义幂等：零副作用）
    const second = convRepo.advanceZeroCursorsForActiveJoin();
    expect(second).toBe(1);
    expect((db.prepare("SELECT last_read_seq FROM conversation_participants WHERE id = 'p7'").get() as { last_read_seq: number }).last_read_seq).toBe(0);
  });

  it("结构不变量：迁移不改表结构（sqlite_master DDL 等价）", () => {
    const before = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_participants'").get() as { sql: string }).sql;
    convRepo.advanceZeroCursorsForActiveJoin();
    const after = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_participants'").get() as { sql: string }).sql;
    expect(after).toBe(before);
  });

  it("功能探针：迁移后 updateLastReadSeq 正常工作（结构无损）", async () => {
    await seed();
    db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p8','conv-1','zero-1','active','2026-01-01T00:00:00Z',0)").run();
    convRepo.advanceZeroCursorsForActiveJoin();

    convRepo.updateLastReadSeq("conv-1", "zero-1", 999);

    const row = db.prepare("SELECT last_read_seq FROM conversation_participants WHERE otter_id = 'zero-1'").get() as { last_read_seq: number };
    expect(row.last_read_seq).toBe(999);
  });
});
