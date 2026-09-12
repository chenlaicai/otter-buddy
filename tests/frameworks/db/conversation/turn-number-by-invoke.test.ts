/**
 * F20260910ctlv 批4c 修复测试：getTurnNumberByInvokeId（新模型链 turn 反查）。
 *
 * 背景：pushCursorOnStartup 旧 SQL 查 messages 表，但收到的 ID 自批4a 起实为
 * invokeId（agent-invoker.ts:333 键控语义换轨）→ 永远 miss → lastActiveTurnNumber
 * 停摆（dispatch-chain-engine:660 闲置提醒读停摆值误报）。
 * 新链：invokes.trigger_entry_id → entries.turn_id → turns.turn_number。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTurnNumberByInvokeId, updateLastActiveTurnNumber, createParticipant, getParticipant } from "@frameworks/db/conversation/conversation-repository-mixins";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import type { Conversation, Turn } from "@entities/conversation/conversation";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";

/** 创建内存 SQLite 并初始化 schema（同目录先例：join-read-cursor） */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

describe("getTurnNumberByInvokeId（F20260910ctlv 批4c 修复：invokeId 语义链）", () => {
  let db: Database.Database;
  let invokeRepo: SqliteInvokeRepository;
  let entryRepo: SqliteEntryRepository;
  let convRepo: SqliteConversationRepository;

  beforeEach(async () => {
    db = createTestDb();
    invokeRepo = new SqliteInvokeRepository(db);
    entryRepo = new SqliteEntryRepository(db);
    convRepo = new SqliteConversationRepository(db);
    new SqliteOtterRepository(db).createOtter({
      id: "otter-1", name: "小獭", type: "small", status: "active",
      role: null, parentOtterId: null,
      createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
    });
    const conv: Conversation = {
      id: "conv-1", title: "测试", status: "active", summary: null, pinned: false,
      workspaceDir: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    await convRepo.create(conv);
    for (const n of [1, 2]) {
      const turn: Turn = {
        id: `turn-${n}`, conversationId: "conv-1", turnNumber: n, status: "closed",
        createdAt: `2026-01-01T00:0${n}:00Z`, closedAt: null,
      };
      await convRepo.createTurn(turn);
    }
  });

  afterEach(() => db.close());

  /** 种子：invoke + 触发它的 user entry（invoke_start 归属同 turn） */
  async function seedInvoke(invokeId: string, triggerEntryId: string | null, turnId: string): Promise<void> {
    await invokeRepo.createInvoke({
      id: invokeId, conversationId: "conv-1", otterId: "otter-1",
      status: "completed", triggerEntryId,
      talkingStonePassedTo: null, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z",
      toolCallCount: 0, tokenUsageInput: null, tokenUsageOutput: null, metadata: null,
    });
    if (triggerEntryId) {
      await entryRepo.createEntryAtomic({
        id: triggerEntryId, conversationId: "conv-1", sequenceNum: 0,
        entryType: "invoke_start", senderType: "otter", senderId: "otter-1",
        body: "", invokeId, yieldTargets: null, turnId,
        status: "completed", source: null, metadata: null, senderName: "小獭",
        contextTokens: null, contextTokensMax: null,
        createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
      });
    }
  }

  it("trigger_entry_id 有值：三表链反查到 turn_number", async () => {
    await seedInvoke("inv-a", "entry-a", "turn-2");

    expect(getTurnNumberByInvokeId(db, "inv-a")).toBe(2);
  });

  it("trigger_entry_id 为空：返回 null（防御——旧 invoke/边界，不抛错）", async () => {
    await seedInvoke("inv-b", null, "turn-1");

    expect(getTurnNumberByInvokeId(db, "inv-b")).toBeNull();
  });

  it("invokeId 不存在：返回 null（不抛错）", () => {
    expect(getTurnNumberByInvokeId(db, "inv-nonexistent")).toBeNull();
  });

  it("端到端：null 分支跳过 lastActiveTurnNumber 推进（pushCursorOnStartup 语义）", async () => {
    createParticipant(db, {
      id: "p-1", conversationId: "conv-1", otterId: "otter-1",
      joinedAtTurnId: "turn-1", joinedAtTurnNumber: 1,
      leftAtTurnId: null, leftAtTurnNumber: null,
      status: "active", createdAt: "2026-01-01T00:00:00Z", leftAt: null,
      lastReadTurnNumber: 1, lastActiveTurnNumber: 0,
    });
    await seedInvoke("inv-c", null, "turn-2");

    // pushCursorOnStartup 的 null 分支：不调 updateLastActiveTurnNumber
    const turnNumber = getTurnNumberByInvokeId(db, "inv-c");
    if (turnNumber !== null) {
      updateLastActiveTurnNumber(db, "conv-1", "otter-1", turnNumber);
    }
    const p = getParticipant(db, "conv-1", "otter-1");
    expect(p?.lastActiveTurnNumber).toBe(0); // 未被推进

    // 对照：有值分支推进生效
    await seedInvoke("inv-d", "entry-d", "turn-2");
    const tn = getTurnNumberByInvokeId(db, "inv-d");
    expect(tn).toBe(2);
    updateLastActiveTurnNumber(db, "conv-1", "otter-1", tn!);
    const p2 = getParticipant(db, "conv-1", "otter-1");
    expect(p2?.lastActiveTurnNumber).toBe(2);
  });
});
