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
import type { Conversation, Turn } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";
import { createTestDb } from "../../helpers/db";

function otterFixture(id: string, name: string): Otter {
  return {
    id, name, type: "small", status: "active",
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
      id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    const turn: Turn = {
      id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    await repo.create(conv);
    await repo.createTurn(turn);
    /** conversation_participants.otter_id 有 FK：参与者必须先有 otter 行 */
    await otterRepo.createOtter(otterFixture("otter-1", "小獭"));
    await otterRepo.createOtter(otterFixture("otter-2", "小獭B"));
    await otterRepo.createOtter(otterFixture("otter-missing-abc12345", "幽灵"));
  });

  afterEach(() => {
    db.close();
  });

  /** join/leave 的系统消息到达终态会触发 tryCloseTurn 关闭当前回合，
   *  连续操作前必须开新回合（真实系统中参与者进出发生在 agent 回合进行中） */
  let turnSeq = 0;
  async function newTurn(): Promise<string> {
    turnSeq += 1;
    const id = `turn-x${turnSeq}`;
    await repo.createTurn({
      id, conversationId: "conv-1", turnNumber: 100 + turnSeq, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    });
    return id;
  }

  describe("join", () => {
    it("创建参与者记录 + system entry（entryDeps 路径），无 open turn 时兜底创建 turn", async () => {
      // 关掉唯一预置的 open turn——彻底切换后常态无 open turn，join 仍须成功
      await repo.closeTurn("turn-1", "2026-01-01T01:00:00Z");

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
      await newTurn();
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
      await newTurn();
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
