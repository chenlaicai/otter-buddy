import { describe, it, expect, vi } from "vitest";
import { tryCloseTurn } from "@usecases/conversation/turn-utils";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Message } from "@entities/conversation/message";

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
    body: "消息",
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
  messagesByTurnId?: Message[];
} = {}): ConversationRepository & {
  _closedTurns: string[];
} {
  const closedTurns: string[] = [];

  return {
    _closedTurns: closedTurns,

    create: vi.fn(),
    getById: vi.fn(),
    updateStatus: vi.fn(),
    getIdsByOtterId: vi.fn(async () => []),
    getAllIds: vi.fn(async () => []),
    updatePinned: vi.fn().mockResolvedValue(undefined),
    getOtterIds: vi.fn(async () => []),
    createTurn: vi.fn(),
    getActiveTurn: vi.fn(async () => null),
    closeTurn: vi.fn(async (turnId: string) => {
      closedTurns.push(turnId);
    }),
    getMaxTurnNumber: vi.fn(async () => 0),
    getMessagesByTurnId: vi.fn(async () => opts.messagesByTurnId ?? []),
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
    createParticipant: vi.fn(),
    createParticipants: vi.fn(),
    getParticipant: vi.fn(async () => null),
    getActiveParticipants: vi.fn(async () => []),
    updateParticipantLeave: vi.fn(),
    updateTokenUsage: vi.fn(async () => {}),
    updateLastReadTurnNumber: vi.fn().mockResolvedValue(undefined),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    getTurnById: vi.fn().mockResolvedValue(null),
    markParticipantLeft: vi.fn().mockResolvedValue(undefined),
    getLastMessageBySender: vi.fn().mockResolvedValue(null),
    getUserReadState: vi.fn().mockResolvedValue(null),
    upsertUserReadState: vi.fn().mockResolvedValue(undefined),
    getFirstUnreadMessage: vi.fn().mockResolvedValue(null),
    getUnreadCount: vi.fn().mockResolvedValue(0),
    getLastMessage: vi.fn().mockResolvedValue(null),
    listConversationsWithMeta: vi.fn().mockResolvedValue([]),
  };
}

describe("tryCloseTurn", () => {
  it("所有消息到达终态时关闭 Turn", async () => {
    const messages = [
      mockMessage({ id: "msg-1", status: "completed" }),
      mockMessage({ id: "msg-2", status: "failed" }),
      mockMessage({ id: "msg-3", status: "aborted" }),
    ];
    const repo = mockRepo({ messagesByTurnId: messages });

    await tryCloseTurn(repo, "turn-1");

    /** 验证 Turn 已关闭 */
    expect(repo._closedTurns).toContain("turn-1");
  });

  it("存在 streaming 消息时不关闭 Turn", async () => {
    const messages = [
      mockMessage({ id: "msg-1", status: "completed" }),
      mockMessage({ id: "msg-2", status: "streaming" }),
    ];
    const repo = mockRepo({ messagesByTurnId: messages });

    await tryCloseTurn(repo, "turn-1");

    /** 验证 Turn 未被关闭 */
    expect(repo._closedTurns).toHaveLength(0);
  });

  it("无消息时关闭 Turn（空数组 every 为 true 的空真逻辑）", async () => {
    const repo = mockRepo({ messagesByTurnId: [] });

    await tryCloseTurn(repo, "turn-1");

    /** 验证空真逻辑：无消息 = 所有消息终态 = 可关闭 */
    expect(repo._closedTurns).toContain("turn-1");
  });
});
