/**
 * ManageParticipant 单元测试（真 sqlite）。
 * join/leave 状态机 + 错误分支 + 名称回退，全部对真 DB 断言。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { ManageParticipant } from "@usecases/conversation/manage-participant";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import type { Conversation, Turn } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";
import { aggregateBody } from "@entities/conversation/message";
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
  let mp: ManageParticipant;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    otterRepo = new SqliteOtterRepository(db);
    mp = new ManageParticipant(repo, otterRepo);

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
    it("创建参与者记录 + 系统消息，返回两者", async () => {
      const result = await mp.join("conv-1", "otter-1", "小獭进场了");

      expect(result.participant.otterId).toBe("otter-1");
      expect(result.participant.status).toBe("active");
      expect(result.participant.conversationId).toBe("conv-1");

      expect(result.systemMessage.senderType).toBe("system");
      expect(aggregateBody(result.systemMessage.segments)).toBe("小獭进场了");
      expect(result.systemMessage.status).toBe("completed");
      expect(result.systemMessage.talkingStonePassedTo).toEqual([]);

      /** 真 DB 断言 */
      const stored = await repo.getParticipant("conv-1", "otter-1");
      expect(stored).not.toBeNull();
      const messages = await repo.getMessages("conv-1", {});
      expect(messages).toHaveLength(1);
      expect(messages[0].senderType).toBe("system");
    });

    it("已进场的 Otter 再次进场抛出 conflict 错误", async () => {
      await mp.join("conv-1", "otter-1", "小獭进场");
      await newTurn();

      await expect(mp.join("conv-1", "otter-1", "小獭又来了")).rejects.toThrow(DomainError);
      await expect(mp.join("conv-1", "otter-1", "小獭又来了")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "conflict",
      );
    });

    it("无活跃 Turn 时抛出 validation 错误", async () => {
      await repo.closeTurn("turn-1", "2026-01-01T01:00:00Z");

      await expect(mp.join("conv-1", "otter-1", "小獭进场")).rejects.toThrow(DomainError);
      await expect(mp.join("conv-1", "otter-1", "小獭进场")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "validation",
      );
    });
  });

  describe("leave", () => {
    it("更新参与者状态为 left + 创建系统消息", async () => {
      const { participant } = await mp.join("conv-1", "otter-1", "小獭进场了");
      const leaveTurnId = await newTurn();

      const result = await mp.leave("conv-1", "otter-1", "小獭退场了");

      expect(result.participant.status).toBe("left");
      expect(result.participant.leftAtTurnId).toBe(leaveTurnId);
      expect(result.participant.leftAt).toBeTruthy();
      expect(aggregateBody(result.systemMessage.segments)).toBe("小獭退场了");
      expect(result.systemMessage.senderType).toBe("system");

      /** 真 DB 断言：参与者已 left，系统消息落库 */
      const stored = await repo.getParticipant("conv-1", "otter-1");
      expect(stored!.status).toBe("left");
      expect(stored!.id).toBe(participant.id);
      const messages = await repo.getMessages("conv-1", {});
      expect(messages).toHaveLength(2);
    });

    it("非活跃参与者退场抛出 validation 错误", async () => {
      await mp.join("conv-1", "otter-1", "小獭进场");
      await newTurn();
      await mp.leave("conv-1", "otter-1", "小獭退场");
      await newTurn();

      await expect(mp.leave("conv-1", "otter-1", "再次退场")).rejects.toThrow(DomainError);
      await expect(mp.leave("conv-1", "otter-1", "再次退场")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "validation",
      );
    });

    it("不存在的参与者退场抛出 validation 错误", async () => {
      await expect(mp.leave("conv-1", "otter-unknown", "未知獭退场")).rejects.toThrow(DomainError);
    });
  });

  describe("getActiveParticipants", () => {
    it("返回带 Otter 名称的参与者列表", async () => {
      await mp.join("conv-1", "otter-1", "A 进场");
      await newTurn();
      await mp.join("conv-1", "otter-2", "B 进场");

      const result = await mp.getActiveParticipants("conv-1");

      expect(result).toHaveLength(2);
      const byOtter = new Map(result.map((r) => [r.participant.otterId, r.otterName]));
      expect(byOtter.get("otter-1")).toBe("小獭");
      expect(byOtter.get("otter-2")).toBe("小獭B");
    });

    it("Otter 行被删除后使用回退名称", async () => {
      await mp.join("conv-1", "otter-missing-abc12345", "幽灵进场");
      /** 生产 foreignKeys 由配置决定（可 OFF）：孤儿参与者真实存在（如 otter 被硬删）。
       *  此处关 FK 复现该场景 */
      db.pragma("foreign_keys = OFF");
      await otterRepo.deleteOtter("otter-missing-abc12345");
      db.pragma("foreign_keys = ON");

      const result = await mp.getActiveParticipants("conv-1");

      expect(result).toHaveLength(1);
      /** 回退名称格式：Otter {id.slice(0,8)} */
      expect(result[0].otterName).toBe("Otter otter-mi");
    });

    it("注入 configProvider 时返回 modelAlias，未配置的 otter 为 undefined", async () => {
      const configProvider = new SqliteOtterConfigProvider(db);
      configProvider.setConfig("otter-1", { otterType: "small", modelAlias: "mimo" });
      configProvider.setConfig("otter-2", { otterType: "small" });
      const mpWithConfig = new ManageParticipant(repo, otterRepo, configProvider);
      await mpWithConfig.join("conv-1", "otter-1", "A 进场");
      await newTurn();
      await mpWithConfig.join("conv-1", "otter-2", "B 进场");

      const result = await mpWithConfig.getActiveParticipants("conv-1");

      const byOtter = new Map(result.map((r) => [r.participant.otterId, r.modelAlias]));
      expect(byOtter.get("otter-1")).toBe("mimo");
      expect(byOtter.get("otter-2")).toBeUndefined();
    });

    it("不注入 configProvider 时 modelAlias 为 undefined（老数据兼容）", async () => {
      await mp.join("conv-1", "otter-1", "A 进场");

      const result = await mp.getActiveParticipants("conv-1");

      expect(result).toHaveLength(1);
      expect(result[0].modelAlias).toBeUndefined();
    });
  });
});
