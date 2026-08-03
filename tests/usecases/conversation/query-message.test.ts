import { describe, it, expect, vi } from "vitest";
import { QueryMessage } from "@usecases/conversation/query-message";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Message } from "@entities/conversation/message";
import { DomainError } from "@entities/errors";

/** 构造消息实体 */
function mockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderType: "user",
    senderId: "user-1",
    talkingStonePassedTo: ["otter-1"],
    status: "completed",
    body: "消息内容",
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    source: "web",
    createdAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** 创建带状态追踪的 ConversationRepository mock */
function mockRepo(opts: {
  messages?: Map<string, Message>;
  messagesBefore?: Message[];
  messagesAfter?: Message[];
  getMessagesResult?: Message[];
} = {}): ConversationRepository {
  const messages = new Map<string, Message>(opts.messages ?? []);

  return {
    create: vi.fn(),
    getById: vi.fn(),
    updateStatus: vi.fn(),
    getIdsByOtterId: vi.fn(async () => []),
    getAllIds: vi.fn(async () => []),
    updatePinned: vi.fn().mockResolvedValue(undefined),
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
    getMessageById: vi.fn(async (id: string) => messages.get(id) ?? null),
    getMessages: vi.fn(async () => opts.getMessagesResult ?? []),
    getMessagesBefore: vi.fn(async () => opts.messagesBefore ?? []),
    getMessagesAfter: vi.fn(async () => opts.messagesAfter ?? []),
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
    createParticipant: vi.fn(),
    createParticipants: vi.fn(),
    getParticipant: vi.fn(async () => null),
    getActiveParticipants: vi.fn(async () => []),
    updateParticipantLeave: vi.fn(),
    updateTokenUsage: vi.fn(async () => {}),
    updateLastReadTurnNumber: vi.fn().mockResolvedValue(undefined),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
  };
}

describe("QueryMessage", () => {
  describe("getMessageById", () => {
    it("委托 repo 返回消息", async () => {
      const msg = mockMessage({ id: "msg-target" });
      const repo = mockRepo({ messages: new Map([["msg-target", msg]]) });
      const qm = new QueryMessage(repo);

      const result = await qm.getMessageById("msg-target");

      expect(result).toEqual(msg);
    });

    it("不存在时返回 null", async () => {
      const repo = mockRepo();
      const qm = new QueryMessage(repo);

      const result = await qm.getMessageById("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("getMessages", () => {
    it("委托 repo 并传递 options", async () => {
      const messages = [mockMessage({ id: "msg-1" }), mockMessage({ id: "msg-2" })];
      const repo = mockRepo({ getMessagesResult: messages });
      const qm = new QueryMessage(repo);

      const result = await qm.getMessages("conv-1", { limit: 10 });

      expect(result).toEqual(messages);
      expect(result).toHaveLength(2);
    });
  });

  describe("expandMessage", () => {
    it("direction=before 返回目标之前的消息", async () => {
      const beforeMessages = [
        mockMessage({ id: "msg-before-1", sequenceNum: 1 }),
        mockMessage({ id: "msg-before-2", sequenceNum: 2 }),
      ];
      const target = mockMessage({ id: "msg-target", sequenceNum: 3 });
      const repo = mockRepo({
        messages: new Map([["msg-target", target]]),
        messagesBefore: beforeMessages,
      });
      const qm = new QueryMessage(repo);

      const result = await qm.expandMessage("msg-target", "before", 5);

      expect(result).toEqual(beforeMessages);
      expect(result).toHaveLength(2);
    });

    it("direction=after 返回目标之后的消息", async () => {
      const afterMessages = [
        mockMessage({ id: "msg-after-1", sequenceNum: 4 }),
        mockMessage({ id: "msg-after-2", sequenceNum: 5 }),
      ];
      const target = mockMessage({ id: "msg-target", sequenceNum: 3 });
      const repo = mockRepo({
        messages: new Map([["msg-target", target]]),
        messagesAfter: afterMessages,
      });
      const qm = new QueryMessage(repo);

      const result = await qm.expandMessage("msg-target", "after", 5);

      expect(result).toEqual(afterMessages);
      expect(result).toHaveLength(2);
    });

    it("direction=both 合并 before + target + after，按 sequenceNum 升序", async () => {
      const beforeMessages = [
        mockMessage({ id: "msg-before", sequenceNum: 1 }),
      ];
      const afterMessages = [
        mockMessage({ id: "msg-after", sequenceNum: 5 }),
      ];
      const target = mockMessage({ id: "msg-target", sequenceNum: 3 });
      const repo = mockRepo({
        messages: new Map([["msg-target", target]]),
        messagesBefore: beforeMessages,
        messagesAfter: afterMessages,
      });
      const qm = new QueryMessage(repo);

      const result = await qm.expandMessage("msg-target", "both", 5);

      expect(result).toHaveLength(3);
      /** 按 sequenceNum 升序排列 */
      expect(result[0].sequenceNum).toBe(1);
      expect(result[1].sequenceNum).toBe(3);
      expect(result[2].sequenceNum).toBe(5);
    });

    it("消息不存在时抛出 not_found 错误", async () => {
      const repo = mockRepo();
      const qm = new QueryMessage(repo);

      await expect(
        qm.expandMessage("nonexistent", "before", 5),
      ).rejects.toThrow(DomainError);

      await expect(
        qm.expandMessage("nonexistent", "before", 5),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "not_found");
    });
  });
});
