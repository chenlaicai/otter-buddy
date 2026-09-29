/**
 * F20260929czi0：进场游标零点修正——仓储层测试。
 *
 * 游标语义：獭的未读集合 = 自其进场点之后、尚未消化的发言；进场前历史不进
 * 未读注入（背景供给归派工简报/检索工具）。取代 F20260913ctlv test15 的
 * 「进场游标=0=读全部历史」口径（该口径让新獭天生背上全对话未读债，
 * 大对话 + 小窗口模型首请求即爆窗——kimi-256k 在 2301 条对话 400 拒答）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Entry } from "@entities/conversation/entry";
import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";
import { createTestDb } from "../../../helpers/db";

describe("进场游标零点（F20260929czi0）", () => {
  let db: Database.Database;
  let entryRepo: SqliteEntryRepository;
  let convRepo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    entryRepo = new SqliteEntryRepository(db);
    convRepo = new SqliteConversationRepository(db);
    const conv: Conversation = {
      id: "conv-1", title: "t", status: "active", summary: null, pinned: false, kind: "normal", workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    convRepo.create(conv);
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
      senderType: "otter", senderId, body, invokeId: null, yieldTargets: null, status: "completed", source: null, metadata: null,
      senderName: "x", contextTokens: null, contextTokensMax: null,
      createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
    };
  }

  function participantFixture(otterId: string, id: string, lastReadSeq?: number): ConversationParticipant {
    return {
      id, conversationId: "conv-1", otterId,
      status: "active", createdAt: "2026-01-01T00:00:00Z", leftAt: null,
      ...(lastReadSeq !== undefined ? { lastReadSeq } : {}),
    };
  }

  describe("createParticipant 游标初值", () => {
    it("带 lastReadSeq 初值写入生效（进场点游标落库）", async () => {
      const q = await entryRepo.createEntryAtomic(entryFixture("big-1", "进场前的问题"));
      const sys = await entryRepo.createEntryAtomic(entryFixture("system", "甲獭 加入了对话", "system"));
      // 加入已有对话：游标 = 进场时刻 max(seq)（含进场 system entry 的 seq）
      const joinSeq = Math.max(q.sequenceNum, sys.sequenceNum);
      convRepo.createParticipant(participantFixture("jia-1", "p-1", joinSeq));

      // 进场前历史（含进场 system entry，sender=甲自己——双重不可见）不进未读
      const unread = await entryRepo.getUnreadEntries("conv-1", "jia-1");
      expect(unread).toEqual([]);
      // 落库值直查（游标写入语义，非读路径映射）
      const row = db.prepare("SELECT last_read_seq FROM conversation_participants WHERE otter_id = 'jia-1'").get() as { last_read_seq: number };
      expect(row.last_read_seq).toBe(joinSeq);
    });

    it("缺省写入 0（新对话初始化调用方零改动、行为不变）", async () => {
      convRepo.createParticipant(participantFixture("jia-1", "p-2"));

      const row = db.prepare("SELECT last_read_seq FROM conversation_participants WHERE otter_id = 'jia-1'").get() as { last_read_seq: number };
      expect(row.last_read_seq).toBe(0);
      // 空对话缺省 0：开场白（写在前）仍可见
      const welcome = await entryRepo.createEntryAtomic(entryFixture("big-1", "开场白", "system"));
      const unread = await entryRepo.getUnreadEntries("conv-1", "jia-1");
      expect(unread.map(e => e.sequenceNum)).toEqual([welcome.sequenceNum]);
    });

    it("createParticipants 批量：带初值与缺省混合写入各自生效", async () => {
      const q = await entryRepo.createEntryAtomic(entryFixture("big-1", "进场前问题"));
      convRepo.createParticipants([
        participantFixture("jia-1", "p-3", q.sequenceNum),
        participantFixture("yi-1", "p-4"),
      ]);

      const rows = db.prepare("SELECT otter_id, last_read_seq FROM conversation_participants").all() as Array<{ otter_id: string; last_read_seq: number }>;
      const byOtter = new Map(rows.map(r => [r.otter_id, r.last_read_seq]));
      expect(byOtter.get("jia-1")).toBe(q.sequenceNum);
      expect(byOtter.get("yi-1")).toBe(0);
    });

    it("进场点之后的新消息正常未读（零点=进场点，不是「全历史」）", async () => {
      await entryRepo.createEntryAtomic(entryFixture("big-1", "进场前的旧问题"));
      const sys = await entryRepo.createEntryAtomic(entryFixture("system", "乙獭 加入了对话", "system"));
      convRepo.createParticipant(participantFixture("yi-1", "p-5", sys.sequenceNum));

      const after1 = await entryRepo.createEntryAtomic(entryFixture("big-1", "进场后新消息"));
      const unread = await entryRepo.getUnreadEntries("conv-1", "yi-1");
      expect(unread.map(e => e.sequenceNum)).toEqual([after1.sequenceNum]);
    });
  });

  describe("进场 system entry 可见性（既有语义固化，检视 S2 订正后的现实断言）", () => {
    it("进场 entry 对新獭不可见（sender=自己，被 sender 过滤排除）；其他在场獭可见", async () => {
      // 大獭先行在场，看得到乙进场
      convRepo.createParticipant(participantFixture("big-1", "p-6", 0));
      const joinEntry = await entryRepo.createEntryAtomic(entryFixture("system", "乙獭 加入了对话", "system"));
      // 乙带进场点游标进场（join 的进场 entry 在游标读数之前落库）
      convRepo.createParticipant(participantFixture("yi-1", "p-7", joinEntry.sequenceNum));

      // 对乙不可见：seq ≤ 游标（且 sender=自己本就被排除）——「我进场了」是写给其他在场獭的仪式性消息
      const unreadYi = await entryRepo.getUnreadEntries("conv-1", "yi-1");
      expect(unreadYi).toEqual([]);
      // 对大獭可见：seq > 0 游标 + sender ≠ 大獭
      const unreadBig = await entryRepo.getUnreadEntries("conv-1", "big-1");
      expect(unreadBig.map(e => e.sequenceNum)).toContain(joinEntry.sequenceNum);
    });
  });
});
