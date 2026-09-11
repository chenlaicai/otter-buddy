/**
 * F20260910ctlv test15：小獭进场已读游标回归测试。
 *
 * 搭档拍板口径：进场游标与进场 system entry 一致——小獭能读到进场那一刻为止的
 * 全部历史（含进场前的大獭发言），否则小獭会重复问「问题是什么」。
 *
 * 根因：createParticipant INSERT 不写 last_read_seq → NULL → getUnreadEntries
 * 对 NULL 返回空；重启 backfill 又把 NULL 填成 max seq（读到最新）。两条路都
 * 读不到进场前历史。修复：进场显式写 last_read_seq=0（读全部）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Entry } from "@entities/conversation/entry";
import type { Conversation, ConversationParticipant, Turn } from "@entities/conversation/conversation";

/** 创建内存 SQLite 并初始化 schema */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

describe("进场已读游标（test15 回归）", () => {
  let db: Database.Database;
  let entryRepo: SqliteEntryRepository;
  let convRepo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    entryRepo = new SqliteEntryRepository(db);
    convRepo = new SqliteConversationRepository(db);
    const conv: Conversation = {
      id: "conv-1", title: "t", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    convRepo.create(conv);
    const turn: Turn = {
      id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    convRepo.createTurn(turn);
    // FK：participants.otter_id 引用 otters——预置甲/乙/大獭行
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('jia-1','甲','small','active','2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('yi-1','乙','small','active','2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('big-1','大獭','big','active','2026-01-01T00:00:00Z')").run();
  });

  afterEach(() => { db.close(); });

  /** entry id 自增计数（seq 原子分配，以 createEntryAtomic 返回值为准） */
  let fixtureSeq = 0;
  function entryFixture(senderId: string, body: string, entryType: Entry["entryType"] = "speak"): Entry {
    fixtureSeq += 1;
    return {
      id: `entry-${fixtureSeq}`, conversationId: "conv-1", sequenceNum: 0, entryType,
      senderType: "otter", senderId, body, invokeId: null, yieldTargets: null,
      turnId: "turn-1", status: "completed", source: null, metadata: null,
      senderName: "x", contextTokens: null, contextTokensMax: null,
      createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
    };
  }

  it("新进场獭 last_read_seq=0 → getUnreadEntries 读到进场前历史（含大獭提的问题）", async () => {
    // 大獭进场前提问题（speak）+ 系统消息（system）——seq 原子分配，以返回值为准
    const q = await entryRepo.createEntryAtomic(entryFixture("big-1", "问题：你最喜欢什么颜色？"));
    const sys = await entryRepo.createEntryAtomic(entryFixture("system", "甲獭 加入了对话", "system"));

    // 甲獭进场（createParticipant）
    const p: ConversationParticipant = {
      id: "p-1", conversationId: "conv-1", otterId: "jia-1",
      joinedAtTurnId: "turn-1", joinedAtTurnNumber: 1,
      leftAtTurnId: null, leftAtTurnNumber: null,
      status: "active", createdAt: "2026-01-01T00:00:00Z", leftAt: null,
      lastReadTurnNumber: 1, lastActiveTurnNumber: 0,
    };
    convRepo.createParticipant(p);

    // 甲獭的未读 = 进场前全部 user/system/speak 条目（不含自己发的）
    const unread = await entryRepo.getUnreadEntries("conv-1", "jia-1");
    expect(unread.map(e => e.sequenceNum)).toEqual([q.sequenceNum, sys.sequenceNum]);
    expect(unread[0]?.body).toContain("问题");
  });

  it("进场后自己产出不重复计未读（sender 过滤），他人后续条目正常未读", async () => {
    const q = await entryRepo.createEntryAtomic(entryFixture("big-1", "问题"));
    const p: ConversationParticipant = {
      id: "p-2", conversationId: "conv-1", otterId: "jia-1",
      joinedAtTurnId: "turn-1", joinedAtTurnNumber: 1,
      leftAtTurnId: null, leftAtTurnNumber: null,
      status: "active", createdAt: "2026-01-01T00:00:00Z", leftAt: null,
      lastReadTurnNumber: 1, lastActiveTurnNumber: 0,
    };
    convRepo.createParticipant(p);
    // 甲獭自己发言 + 大獭新发言
    const own = await entryRepo.createEntryAtomic(entryFixture("jia-1", "我的回答"));
    const next = await entryRepo.createEntryAtomic(entryFixture("big-1", "收到"));

    const unread = await entryRepo.getUnreadEntries("conv-1", "jia-1");
    expect(unread.map(e => e.sequenceNum)).toEqual([q.sequenceNum, next.sequenceNum]);
    void own;
  });

  it("退场獭（status=left）不返回未读", async () => {
    await entryRepo.createEntryAtomic(entryFixture("big-1", "问题"));
    const p: ConversationParticipant = {
      id: "p-3", conversationId: "conv-1", otterId: "yi-1",
      joinedAtTurnId: "turn-1", joinedAtTurnNumber: 1,
      leftAtTurnId: null, leftAtTurnNumber: null,
      status: "active", createdAt: "2026-01-01T00:00:00Z", leftAt: null,
      lastReadTurnNumber: 1, lastActiveTurnNumber: 0,
    };
    convRepo.createParticipant(p);
    db.prepare("UPDATE conversation_participants SET status = 'left' WHERE otter_id = 'yi-1'").run();

    const unread = await entryRepo.getUnreadEntries("conv-1", "yi-1");
    expect(unread).toEqual([]);
  });
});
