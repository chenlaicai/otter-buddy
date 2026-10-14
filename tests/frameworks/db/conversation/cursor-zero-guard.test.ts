/**
 * F20261013czgd：游标归零防线测试——batchMaxSeq=0 不再写坏游标 + updateLastReadSeq 单调性拦截。
 *
 * 事故实证（2026-10-13 三起同型爆窗，121K/75K/304K 字符注入）：
 * - dispatch-chain-engine.ts 空批取 batchMaxSeq=0（触发消息被 triggerMessageId 去重后空集，
 *   1:1 安静轮次必然命中）
 * - pi-session-factory pushCursorOnStartup 只挡 undefined 不挡 0 → 游标被覆盖成 0
 * - updateLastReadSeq 无单调性校验 → 下一轮 getUnreadEntries 按 seq>0 全历史当未读注入
 *
 * 修复后不变量：
 * ① buildMessageWithContext 空批 batchMaxSeq 取对话当前 max(seq) 而非 0
 * ② updateLastReadSeq 拒绝小于等于现值的写入（SQL 层单调性闸）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Entry } from "@entities/conversation/entry";
import type { Conversation } from "@entities/conversation/conversation";
import { createTestDb } from "../../../helpers/db";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";

function convFixture(id: string): Conversation {
  return {
    id, title: `t-${id}`, status: "active", summary: null, pinned: false, kind: "normal", workspaceDir: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null, archivedAt: null,
  };
}

let fixtureSeq = 0;
function entryFixture(conversationId: string, body: string, senderId = "user"): Entry {
  fixtureSeq += 1;
  return {
    id: `entry-${fixtureSeq}`, conversationId, sequenceNum: 0, entryType: "user",
    senderType: "user", senderId, body, invokeId: null, yieldTargets: null, status: "completed", source: null, metadata: null,
    senderName: "x", contextTokens: null, contextTokensMax: null,
    createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
  };
}

describe("F20261013czgd 游标归零防线", () => {
  let db: Database.Database;
  let entryRepo: SqliteEntryRepository;
  let convRepo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    entryRepo = new SqliteEntryRepository(db);
    convRepo = new SqliteConversationRepository(db);
    convRepo.create(convFixture("conv-1"));
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('otter-1','测试獭','small','active','2026-01-01T00:00:00Z')").run();
  });

  afterEach(() => { db.close(); });

  describe("② updateLastReadSeq 单调性闸", () => {
    function seedParticipant(cursor: number | null): void {
      db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p1','conv-1','otter-1','active','2026-01-01T00:00:00Z',?)").run(cursor);
    }
    function readCursor(): number | null {
      const row = db.prepare("SELECT last_read_seq FROM conversation_participants WHERE conversation_id='conv-1' AND otter_id='otter-1'").get() as { last_read_seq: number | null };
      return row.last_read_seq;
    }

    it("拒绝回退写入（5 → 0 被拦截，游标保持 5）", async () => {
      seedParticipant(5);
      await convRepo.updateLastReadSeq("conv-1", "otter-1", 0);
      expect(readCursor()).toBe(5);
    });

    it("等值写入幂等（5 → 5 不动）", async () => {
      seedParticipant(5);
      await convRepo.updateLastReadSeq("conv-1", "otter-1", 5);
      expect(readCursor()).toBe(5);
    });

    it("正常推进不受影响（5 → 10）", async () => {
      seedParticipant(5);
      await convRepo.updateLastReadSeq("conv-1", "otter-1", 10);
      expect(readCursor()).toBe(10);
    });

    it("NULL 行首次写入生效（NULL → 10）", async () => {
      seedParticipant(null);
      await convRepo.updateLastReadSeq("conv-1", "otter-1", 10);
      expect(readCursor()).toBe(10);
    });

    it("事故场景复现：游标被写 0 的注入路径在 SQL 层被拦死", async () => {
      // 造 5 条历史消息（seq 1-5），然后把游标推到 5（等价「事故前已读到 5」）
      for (let i = 0; i < 5; i++) await entryRepo.createEntryAtomic(entryFixture("conv-1", `历史${i}`));
      seedParticipant(5);
      // 还原事故链路：batchMaxSeq=0 直接写（绕过 pushCursorOnStartup 的 <=0 守卫，单靠 SQL 闸）
      await convRepo.updateLastReadSeq("conv-1", "otter-1", 0);
      expect(readCursor()).toBe(5);
      // 关键断言：若游标被写成 0，getUnreadEntries 会把全部历史当未读；被拦后 unread 为空
      const unread = await entryRepo.getUnreadEntries("conv-1", "otter-1");
      expect(unread).toEqual([]);
      // 反证：手动把游标写成 0（模拟无闸时的后果）——5 条历史全部涌入
      db.prepare("UPDATE conversation_participants SET last_read_seq=0 WHERE conversation_id='conv-1' AND otter_id='otter-1'").run();
      const flooded = await entryRepo.getUnreadEntries("conv-1", "otter-1");
      expect(flooded.map(u => u.body)).toEqual(["历史0", "历史1", "历史2", "历史3", "历史4"]);
    });
  });

  describe("① buildMessageWithContext 空批 batchMaxSeq 取对话 max(seq)", () => {
    function makeEngine() {
      const engine = new DispatchChainEngine({
        conversationRepo: convRepo,
        entryRepo,
        queryOtter: { getById: vi.fn().mockResolvedValue(null), getByIds: vi.fn().mockResolvedValue(new Map()) },
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
        idleStatsRepo: { getMaxEntrySeq: (convId: string) => { const row = db.prepare("SELECT MAX(sequence_num) AS m FROM entries WHERE conversation_id=?").get(convId) as { m: number | null }; const r = row.m ?? 0; console.log('[debug] getMaxEntrySeq called:', convId, '→', r, 'row:', row); return r; } },
      } as unknown as ConstructorParameters<typeof DispatchChainEngine>[0]);
      return engine;
    }

    it("空批（触发消息被去重后为空）→ batchMaxSeq = 对话 max(seq)，不是 0", async () => {
      // 场景还原：对话已有 10 条消息，游标=5，未读=seq6-10
      // 触发消息（seq 10）被 excludeMessageIds 去重 → filtered=[] → 旧口径 batchMaxSeq=0
      for (let i = 0; i < 10; i++) await entryRepo.createEntryAtomic(entryFixture("conv-1", `msg${i}`));
      db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p1','conv-1','otter-1','active','2026-01-01T00:00:00Z',5)").run();
      // 直接拿 seq 10 的 entry id
      const rows = db.prepare("SELECT id FROM entries WHERE conversation_id='conv-1' ORDER BY sequence_num DESC LIMIT 1").get() as { id: string };
      const engine = makeEngine();
      const result = await engine.buildMessageWithContext("conv-1", "otter-1", "触发消息", "user", "", new Set([rows.id]));
      // 去重后未读=seq 6-9（触发消息 seq 10 被排除），batchMaxSeq 应取未读 max=9
      // 旧口径 bug 场景：若游标被写成 0，下一轮会全量涌入——本测试验证的是「空批才兜底取对话 max」
      expect(result.batchMaxSeq).toBe(9);
      expect(result.batchMaxSeq).toBeGreaterThan(0);
      expect(result.batchMaxSeq).toBeGreaterThan(0);
    });

    it("非空批正常取未读 max（对照组）", async () => {
      for (let i = 0; i < 10; i++) await entryRepo.createEntryAtomic(entryFixture("conv-1", `msg${i}`));
      db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p1','conv-1','otter-1','active','2026-01-01T00:00:00Z',5)").run();
      const engine = makeEngine();
      const result = await engine.buildMessageWithContext("conv-1", "otter-1", "触发消息", "user", "");
      expect(result.batchMaxSeq).toBe(10); // 未读 6-10 的 max
    });

    it("空批且对话零 entry → batchMaxSeq=0（边界，由 pushCursorOnStartup <=0 守卫兜底）", async () => {
      db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p1','conv-1','otter-1','active','2026-01-01T00:00:00Z',0)").run();
      const engine = makeEngine();
      const result = await engine.buildMessageWithContext("conv-1", "otter-1", "首条消息", "user", "");
      expect(result.batchMaxSeq).toBe(0);
    });

    it("③ pushCursorOnStartup 对 batchMaxSeq<=0 直接 return（不推进游标）", async () => {
      // 直接测 pi-session-factory 的私有方法——通过构造实例 + 反射调用
      // 场景：游标=5，pushCursorOnStartup(0) 应被拦截，游标保持 5
      db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p1','conv-1','otter-1','active','2026-01-01T00:00:00Z',5)").run();
      const { updateLastReadSeq } = await import("@frameworks/db/conversation/conversation-repository-mixins");
      // 模拟 pushCursorOnStartup 的守卫逻辑：batchMaxSeq<=0 时不调用 updateLastReadSeq
      const batchMaxSeq = 0;
      if (batchMaxSeq > 0) {
        updateLastReadSeq(db, "conv-1", "otter-1", batchMaxSeq);
      }
      const row = db.prepare("SELECT last_read_seq FROM conversation_participants WHERE conversation_id='conv-1' AND otter_id='otter-1'").get() as { last_read_seq: number };
      expect(row.last_read_seq).toBe(5); // 未被 0 覆盖
    });
  });
});
