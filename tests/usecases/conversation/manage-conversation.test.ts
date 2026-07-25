import { describe, it, expect, vi } from "vitest";
import { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { DomainError } from "@entities/errors";

/** 创建大獭 mock（返回固定 Otter） */
function mockBigOtter(): Otter {
  return {
    id: "otter-big-001",
    name: "大獭",
    type: "big",
    status: "active",
    role: null,
    parentOtterId: null,
    createdAt: new Date().toISOString(),
    dissolvedAt: null,
  };
}

/** 创建带状态追踪的 ConversationRepository mock */
function mockRepo(initialConversations: Map<string, Conversation> = new Map()): ConversationRepository & {
  _conversations: Map<string, Conversation>;
  _participants: ConversationParticipant[];
  _statusUpdates: Array<{ id: string; status: string; timestamp: string }>;
} {
  const conversations = new Map(initialConversations);
  const participants: ConversationParticipant[] = [];
  const statusUpdates: Array<{ id: string; status: string; timestamp: string }> = [];

  return {
    _conversations: conversations,
    _participants: participants,
    _statusUpdates: statusUpdates,

    create: vi.fn(async (conv: Conversation) => {
      conversations.set(conv.id, conv);
    }),
    getById: vi.fn(async (id: string) => conversations.get(id) ?? null),
    updateStatus: vi.fn(async (id: string, status: Conversation["status"], timestamp: string) => {
      const conv = conversations.get(id);
      if (conv) {
        conv.status = status;
        if (status === "completed") conv.completedAt = timestamp;
        if (status === "archived") conv.archivedAt = timestamp;
      }
      statusUpdates.push({ id, status, timestamp });
    }),
    getIdsByOtterId: vi.fn(async () => []),
    getAllIds: vi.fn(async () => []),
    getOtterIds: vi.fn(async () => []),
    createTurn: vi.fn(),
    getActiveTurn: vi.fn(async () => null),
    closeTurn: vi.fn(),
    getMaxTurnNumber: vi.fn(async () => 0),
    getMessagesByTurnId: vi.fn(async () => []),
    createCompletedMessage: vi.fn(),
    createStreamingMessage: vi.fn(),
    startSpeaking: vi.fn(async () => {}),
    completeMessage: vi.fn(),
    failMessage: vi.fn(),
    failInFlightMessages: vi.fn(async () => 0),
    closeOrphanedTurns: vi.fn(async () => 0),
    abortMessage: vi.fn(),
    getMaxSequenceNum: vi.fn(async () => 0),
    getMessageById: vi.fn(async () => null),
    getMessages: vi.fn(async () => []),
    getMessagesBefore: vi.fn(async () => []),
    getMessagesAfter: vi.fn(async () => []),
    appendEvent: vi.fn(),
    getMessageEvents: vi.fn(async () => []),
    getMessageEventsByMessageIds: vi.fn(async () => []),
    getMaxEventSequenceNum: vi.fn(async () => 0),
    searchMessages: vi.fn(async () => []),
    getTurnHistory: vi.fn(async () => []),
    linkResource: vi.fn(),
    getLinkedResources: vi.fn(async () => []),
    getLinkedResourceById: vi.fn(async () => null),
    getLinkedResourcesByGroup: vi.fn(async () => []),
    updateResourceStatus: vi.fn(),
    supersedeLinkedResource: vi.fn(),
    deleteLinkedResource: vi.fn(),
    flagResource: vi.fn(),
    createParticipant: vi.fn(async (p: ConversationParticipant) => {
      participants.push(p);
    }),
    createParticipants: vi.fn(async (ps: ConversationParticipant[]) => {
      participants.push(...ps);
    }),
    getParticipant: vi.fn(async () => null),
    getActiveParticipants: vi.fn(async () => []),
    updateParticipantLeave: vi.fn(),
    updateTokenUsage: vi.fn(async () => {}),
    updateLastReadTurnNumber: vi.fn().mockResolvedValue(undefined),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
  };
}

/** 创建 CreateOtter mock */
function mockCreateOtter(otter?: Otter): CreateOtter {
  const bigOtter = otter ?? mockBigOtter();
  return {
    execute: vi.fn(async () => bigOtter),
  } as unknown as CreateOtter;
}

/** 构造一个已存在的对话实体 */
function existingConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-existing",
    title: "测试对话",
    status: "active",
    summary: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("ManageConversation", () => {
  describe("create", () => {
    it("创建对话，状态为 active，包含正确字段", async () => {
      const repo = mockRepo();
      const createOtter = mockCreateOtter();
      const mc = new ManageConversation(repo, createOtter);

      const conv = await mc.create({ title: "新对话" });

      expect(conv.status).toBe("active");
      expect(conv.title).toBe("新对话");
      expect(conv.summary).toBeNull();
      expect(conv.completedAt).toBeNull();
      expect(conv.archivedAt).toBeNull();
      expect(conv.id).toMatch(/^[0-9a-f-]{36}$/);

      /** 验证 repo 中已存储该对话 */
      const stored = repo._conversations.get(conv.id);
      expect(stored).toBeTruthy();
      expect(stored?.title).toBe("新对话");
    });

    it("调用 createOtter.execute 创建大獭", async () => {
      const repo = mockRepo();
      const bigOtter = mockBigOtter();
      const createOtter = mockCreateOtter(bigOtter);
      const mc = new ManageConversation(repo, createOtter);

      const conv = await mc.create({ title: "对话" });

      /** 验证 createOtter.execute 返回的大獭 ID 被用于参与者记录 */
      const participant = repo._participants.find(
        (p) => p.conversationId === conv.id,
      );
      expect(participant).toBeTruthy();
      expect(participant?.otterId).toBe(bigOtter.id);
      expect(participant?.status).toBe("active");
    });

    it("为大獭创建初始参与者记录", async () => {
      const repo = mockRepo();
      const mc = new ManageConversation(repo, mockCreateOtter());

      const conv = await mc.create({ title: "参与者测试" });

      /** 验证参与者记录：joinedAtTurnId=null, joinedAtTurnNumber=0 表示对话开始前已在场 */
      const participant = repo._participants.find(
        (p) => p.conversationId === conv.id,
      );
      expect(participant).toBeTruthy();
      expect(participant?.joinedAtTurnId).toBeNull();
      expect(participant?.joinedAtTurnNumber).toBe(0);
      expect(participant?.leftAtTurnId).toBeNull();
      expect(participant?.status).toBe("active");
    });
  });

  describe("getById", () => {
    it("委托 repo 返回对话", async () => {
      const conv = existingConv({ id: "conv-123" });
      const repo = mockRepo(new Map([["conv-123", conv]]));
      const mc = new ManageConversation(repo, mockCreateOtter());

      const result = await mc.getById("conv-123");

      expect(result).toEqual(conv);
    });

    it("不存在时返回 null", async () => {
      const repo = mockRepo();
      const mc = new ManageConversation(repo, mockCreateOtter());

      const result = await mc.getById("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("complete", () => {
    it("active 对话 -> 更新状态为 completed", async () => {
      const conv = existingConv({ status: "active" });
      const repo = mockRepo(new Map([[conv.id, conv]]));
      const mc = new ManageConversation(repo, mockCreateOtter());

      await mc.complete(conv.id);

      /** 验证状态已更新 */
      expect(repo._conversations.get(conv.id)?.status).toBe("completed");
      expect(repo._statusUpdates[0].status).toBe("completed");
    });

    it("不存在 -> 抛出 DomainError not_found", async () => {
      const repo = mockRepo();
      const mc = new ManageConversation(repo, mockCreateOtter());

      await expect(mc.complete("nonexistent")).rejects.toThrow(DomainError);
      await expect(mc.complete("nonexistent")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "not_found",
      );
    });

    it("已完成 -> 抛出 DomainError validation", async () => {
      const conv = existingConv({ status: "completed" });
      const repo = mockRepo(new Map([[conv.id, conv]]));
      const mc = new ManageConversation(repo, mockCreateOtter());

      await expect(mc.complete(conv.id)).rejects.toThrow(DomainError);
      await expect(mc.complete(conv.id)).rejects.toSatisfy(
        (err: DomainError) => err.kind === "validation",
      );
    });
  });

  describe("archive", () => {
    it("completed 对话 -> 更新状态为 archived", async () => {
      const conv = existingConv({ status: "completed" });
      const repo = mockRepo(new Map([[conv.id, conv]]));
      const mc = new ManageConversation(repo, mockCreateOtter());

      await mc.archive(conv.id);

      expect(repo._conversations.get(conv.id)?.status).toBe("archived");
      expect(repo._statusUpdates[0].status).toBe("archived");
    });

    it("active 对话 -> 抛出 DomainError（不能归档活跃对话）", async () => {
      const conv = existingConv({ status: "active" });
      const repo = mockRepo(new Map([[conv.id, conv]]));
      const mc = new ManageConversation(repo, mockCreateOtter());

      await expect(mc.archive(conv.id)).rejects.toThrow(DomainError);
      await expect(mc.archive(conv.id)).rejects.toSatisfy(
        (err: DomainError) => err.kind === "validation",
      );
    });

    it("不存在 -> 抛出 DomainError not_found", async () => {
      const repo = mockRepo();
      const mc = new ManageConversation(repo, mockCreateOtter());

      await expect(mc.archive("nonexistent")).rejects.toThrow(DomainError);
      await expect(mc.archive("nonexistent")).rejects.toSatisfy(
        (err: DomainError) => err.kind === "not_found",
      );
    });
  });
});
