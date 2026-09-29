/**
 * ManageParticipant 单元测试（真 sqlite）。
 * join/leave 状态机 + 错误分支 + 名称回退，全部对真 DB 断言。
 * F20260913ctlv：注入 entryDeps 后进场/退场系统消息写 system entry（entries 表），
 * 无 open turn 时 ensureActiveTurn 兜底创建（旧硬校验已删）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { ManageParticipant } from "@usecases/conversation/manage-participant";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";
import type { Conversation } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";
import { createTestDb } from "../../helpers/db";

function otterFixture(id: string, name: string): Otter {
  return {
    id, name, type: "small", status: "active",
    color: null,
    role: null, parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
  };
}

describe("ManageParticipant（真 sqlite）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;
  /** entry 路径实例（F20260913ctlv：进场/退场 system entry） */
  let mpEntry: ManageParticipant;
  let entryRepo: SqliteEntryRepository;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    otterRepo = new SqliteOtterRepository(db);
    entryRepo = new SqliteEntryRepository(db);
    mpEntry = new ManageParticipant(repo, otterRepo, {
      entryRepo,
      invokeRepo: new SqliteInvokeRepository(db),
    });

    const conv: Conversation = {
      id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, kind: "normal", workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    await repo.create(conv);
    /** conversation_participants.otter_id 有 FK：参与者必须先有 otter 行 */
    await otterRepo.createOtter(otterFixture("otter-1", "小獭"));
    await otterRepo.createOtter(otterFixture("otter-2", "小獭B"));
    await otterRepo.createOtter(otterFixture("otter-missing-abc12345", "幽灵"));
  });

  afterEach(() => {
    db.close();
  });

  describe("join", () => {
    it("创建参与者记录 + system entry（entryDeps 路径）", async () => {
      const result = await mpEntry.join("conv-1", "otter-1", "小獭进场了");

      expect(result.participant.otterId).toBe("otter-1");
      expect(result.participant.status).toBe("active");
      expect(result.participant.conversationId).toBe("conv-1");

      // system entry 断言
      expect("entryType" in result.systemMessage).toBe(true);
      const entry = result.systemMessage as import("@entities/conversation/entry").Entry;
      expect(entry.entryType).toBe("system");
      expect(entry.body).toBe("小獭进场了");
      expect(entry.status).toBe("completed");
      // entry 路径写 entries（messages 表已 drop）
      const sysEntries = await entryRepo.getEntries("conv-1", { entryType: "system", limit: 5 });
      expect(sysEntries.some(e => e.body === "小獭进场了")).toBe(true);

      /** 真 DB 断言 */
      const stored = await repo.getParticipant("conv-1", "otter-1");
      expect(stored).not.toBeNull();
    });

    it("已进场的 Otter 再次进场抛出 conflict 错误", async () => {
      await mpEntry.join("conv-1", "otter-1", "小獭进场");

      await expect(mpEntry.join("conv-1", "otter-1", "小獭又来了")).rejects.toThrow(DomainError);
      await expect(mpEntry.join("conv-1", "otter-1", "小獭又来了")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "conflict",
      );
    });
  });

  describe("join 进场游标（F20260929czi0：零点=进场点）", () => {
    it("已有 N 条 entries 的对话进场 → 游标 = 进场时刻 max(seq)，进场前历史不可见，进场后新消息可见", async () => {
      // Arrange：大獭先行在场并发言（进场前历史）
      await otterRepo.createOtter(otterFixture("big-0", "大獭甲"));
      db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq) VALUES ('p-big','conv-1','big-0','active','2026-01-01T00:00:00Z',0)").run();
      const q = await entryRepo.createEntryAtomic({
        id: "e-1", conversationId: "conv-1", sequenceNum: 0, entryType: "speak",
        senderType: "otter", senderId: "big-0", body: "进场前的问题", invokeId: null, yieldTargets: null,
        status: "completed", source: null, metadata: null, senderName: "大獭甲",
        contextTokens: null, contextTokensMax: null,
        createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
      });

      // Act：小獭进场（join 会写进场 system entry，seq > q）
      await mpEntry.join("conv-1", "otter-1", "小獭进场了");

      // Assert：游标 = join 读 maxSeq 时刻的 max(seq)=q 的 seq（进场 entry 在游标读数之后落库，
      // 且其 sender=新獭自己被 sender 过滤排除——双重不可见，语义等价）
      const row = db.prepare("SELECT last_read_seq FROM conversation_participants WHERE otter_id = 'otter-1'").get() as { last_read_seq: number };
      expect(row.last_read_seq).toBe(q.sequenceNum);
      // 进场前历史不进未读（旧口径下这里是全历史）
      let unread = await entryRepo.getUnreadEntries("conv-1", "otter-1");
      expect(unread).toEqual([]);
      // 进场后新消息可见
      const next = await entryRepo.createEntryAtomic({
        id: "e-2", conversationId: "conv-1", sequenceNum: 0, entryType: "speak",
        senderType: "otter", senderId: "big-0", body: "进场后的新消息", invokeId: null, yieldTargets: null,
        status: "completed", source: null, metadata: null, senderName: "大獭甲",
        contextTokens: null, contextTokensMax: null,
        createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
      });
      unread = await entryRepo.getUnreadEntries("conv-1", "otter-1");
      expect(unread.map(e => e.sequenceNum)).toEqual([next.sequenceNum]);
    });

    it("空对话进场 → 游标 = 0（= max(seq)），开场白可见", async () => {
      await mpEntry.join("conv-1", "otter-1", "小獭进场了");

      const row = db.prepare("SELECT last_read_seq FROM conversation_participants WHERE otter_id = 'otter-1'").get() as { last_read_seq: number };
      expect(row.last_read_seq).toBe(0);
      // 开场白（进场后写入）可见
      const welcome = await entryRepo.createEntryAtomic({
        id: "e-3", conversationId: "conv-1", sequenceNum: 0, entryType: "system",
        senderType: "system", senderId: "user-1", body: "开场白", invokeId: null, yieldTargets: null,
        status: "completed", source: null, metadata: null, senderName: "system",
        contextTokens: null, contextTokensMax: null,
        createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
      });
      const unread = await entryRepo.getUnreadEntries("conv-1", "otter-1");
      expect(unread.map(e => e.sequenceNum)).toEqual([welcome.sequenceNum]);
    });

    it("进场 system entry 对新獭不可见（sender=自己，固化既有语义防回归）", async () => {
      const { systemMessage } = await mpEntry.join("conv-1", "otter-1", "小獭进场了");
      expect(systemMessage.senderId).toBe("otter-1");

      // 新獭的未读不含自己的进场 entry（getUnreadEntries 排除 sender=自己）
      const unread = await entryRepo.getUnreadEntries("conv-1", "otter-1");
      expect(unread.filter(e => e.senderId === "otter-1")).toEqual([]);
    });
  });

  describe("leave", () => {
    it("更新参与者状态为 left + system entry（entryDeps 路径）", async () => {
      const { participant } = await mpEntry.join("conv-1", "otter-1", "小獭进场了");

      const result = await mpEntry.leave("conv-1", "otter-1", "小獭退场了");

      expect(result.participant.status).toBe("left");
      expect(result.participant.leftAt).toBeTruthy();
      const entry = result.systemMessage as import("@entities/conversation/entry").Entry;
      expect(entry.entryType).toBe("system");
      expect(entry.body).toBe("小獭退场了");

      /** 真 DB 断言：参与者已 left，system entry 落库 */
      const stored = await repo.getParticipant("conv-1", "otter-1");
      expect(stored!.status).toBe("left");
      expect(stored!.id).toBe(participant.id);
    });

    it("非活跃参与者退场抛出 validation 错误", async () => {
      await mpEntry.join("conv-1", "otter-1", "小獭进场");
      await mpEntry.leave("conv-1", "otter-1", "小獭退场");

      await expect(mpEntry.leave("conv-1", "otter-1", "再次退场")).rejects.toThrow(DomainError);
      await expect(mpEntry.leave("conv-1", "otter-1", "再次退场")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "validation",
      );
    });

    it("不存在的参与者退场抛出 validation 错误", async () => {
      await expect(mpEntry.leave("conv-1", "otter-unknown", "未知獭退场")).rejects.toThrow(DomainError);
    });
  });

  describe("getActiveParticipants", () => {
    it("返回带 Otter 名称的参与者列表", async () => {
      await mpEntry.join("conv-1", "otter-1", "A 进场");
      await mpEntry.join("conv-1", "otter-2", "B 进场");

      const result = await mpEntry.getActiveParticipants("conv-1");

      expect(result).toHaveLength(2);
      const byOtter = new Map(result.map((r) => [r.participant.otterId, r.otterName]));
      expect(byOtter.get("otter-1")).toBe("小獭");
      expect(byOtter.get("otter-2")).toBe("小獭B");
    });

    it("Otter 行被删除后使用回退名称", async () => {
      await mpEntry.join("conv-1", "otter-missing-abc12345", "幽灵进场");
      /** 生产 foreignKeys 由配置决定（可 OFF）：孤儿参与者真实存在（如 otter 被硬删）。
       *  此处关 FK 复现该场景 */
      db.pragma("foreign_keys = OFF");
      await otterRepo.deleteOtter("otter-missing-abc12345");
      db.pragma("foreign_keys = ON");

      const result = await mpEntry.getActiveParticipants("conv-1");

      expect(result).toHaveLength(1);
      /** 回退名称格式：Otter {id.slice(0,8)} */
      expect(result[0].otterName).toBe("Otter otter-mi");
    });

    it("注入 configProvider 时返回 modelAlias，未配置的 otter 为 undefined", async () => {
      const configProvider = new SqliteOtterConfigProvider(db);
      configProvider.setConfig("otter-1", { otterType: "small", modelAlias: "mimo" });
      configProvider.setConfig("otter-2", { otterType: "small" });
      const mpWithConfig = new ManageParticipant(repo, otterRepo, { entryRepo, invokeRepo: new SqliteInvokeRepository(db) }, configProvider);
      await mpWithConfig.join("conv-1", "otter-1", "A 进场");
      await mpWithConfig.join("conv-1", "otter-2", "B 进场");

      const result = await mpWithConfig.getActiveParticipants("conv-1");

      const byOtter = new Map(result.map((r) => [r.participant.otterId, r.modelAlias]));
      expect(byOtter.get("otter-1")).toBe("mimo");
      expect(byOtter.get("otter-2")).toBeUndefined();
    });

    it("不注入 configProvider 时 modelAlias 为 undefined（老数据兼容）", async () => {
      await mpEntry.join("conv-1", "otter-1", "A 进场");

      const result = await mpEntry.getActiveParticipants("conv-1");

      expect(result).toHaveLength(1);
      expect(result[0].modelAlias).toBeUndefined();
    });
  });
});
