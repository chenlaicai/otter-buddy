import { describe, it, expect, vi } from "vitest";
import { SendMessage } from "@usecases/conversation/send-message";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { Logger } from "@usecases/ports/logger";
import type { Turn } from "@entities/conversation/conversation";
import type { Message, MessageEvent } from "@entities/conversation/message";
import { DomainError } from "@entities/errors";

/** 创建 noop Logger mock */
function mockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => mockLogger(),
  };
}

/** 创建带状态追踪的 ConversationRepository mock */
function mockRepo(opts: {
  activeTurn?: Turn | null;
  messages?: Map<string, Message>;
  maxSequenceNum?: number;
  maxTurnNumber?: number;
  maxEventSequenceNum?: number;
} = {}): ConversationRepository & {
  _messages: Map<string, Message>;
  _events: MessageEvent[];
  _turns: Turn[];
  _closedTurns: string[];
  _failedMessages: Array<{ id: string; failedAt: string; body?: string }>;
  _abortedMessages: Array<{ id: string; body: string; talkingStonePassedTo: string[]; abortedAt: string }>;
  _completedMessages: Array<{ messageId: string; body: string; talkingStonePassedTo: string[] }>;
} {
  const defaultTurn: Turn = {
    id: "turn-1",
    conversationId: "conv-1",
    turnNumber: 1,
    status: "open",
    createdAt: "2026-01-01T00:00:00Z",
    closedAt: null,
  };
  const activeTurn: Turn | null = opts.activeTurn !== undefined ? opts.activeTurn : defaultTurn;
  const messages = new Map<string, Message>(opts.messages ?? []);
  const events: MessageEvent[] = [];
  const turns: Turn[] = activeTurn ? [activeTurn] : [];
  const closedTurns: string[] = [];
  const failedMessages: Array<{ id: string; failedAt: string; body?: string }> = [];
  const abortedMessages: Array<{ id: string; body: string; talkingStonePassedTo: string[]; abortedAt: string }> = [];
  const completedMessages: Array<{ messageId: string; body: string; talkingStonePassedTo: string[] }> = [];
  const maxSequenceNum = opts.maxSequenceNum ?? 0;
  const maxTurnNumber = opts.maxTurnNumber ?? 0;
  const maxEventSequenceNum = opts.maxEventSequenceNum ?? 0;

  return {
    _messages: messages,
    _events: events,
    _turns: turns,
    _closedTurns: closedTurns,
    _failedMessages: failedMessages,
    _abortedMessages: abortedMessages,
    _completedMessages: completedMessages,

    create: vi.fn(),
    getById: vi.fn(),
    updateStatus: vi.fn(),
    getIdsByOtterId: vi.fn(async () => []),
    getAllIds: vi.fn(async () => []),
    getOtterIds: vi.fn(async () => []),
    createTurn: vi.fn(async (turn: Turn) => {
      turns.push(turn);
    }),
    getActiveTurn: vi.fn(async () => activeTurn),
    closeTurn: vi.fn(async (turnId: string) => {
      closedTurns.push(turnId);
    }),
    getMaxTurnNumber: vi.fn(async () => maxTurnNumber),
    getMessagesByTurnId: vi.fn(async () => {
      return [...messages.values()].filter((m) => m.turnId === (activeTurn?.id ?? "turn-1"));
    }),
    createCompletedMessage: vi.fn(async (msg: Message) => {
      messages.set(msg.id, msg);
    }),
    createStreamingMessage: vi.fn(async (msg: Message) => {
      messages.set(msg.id, msg);
    }),
    completeMessage: vi.fn(async (input: { messageId: string; body: string; talkingStonePassedTo: string[] }) => {
      const msg = messages.get(input.messageId);
      if (msg) {
        msg.status = "completed";
        msg.body = input.body;
        msg.talkingStonePassedTo = input.talkingStonePassedTo;
      }
      completedMessages.push({ messageId: input.messageId, body: input.body, talkingStonePassedTo: input.talkingStonePassedTo });
    }),
    failMessage: vi.fn(async (id: string, failedAt: string, body?: string) => {
      const msg = messages.get(id);
      if (msg) msg.status = "failed";
      failedMessages.push({ id, failedAt, body });
    }),
    abortMessage: vi.fn(async (id: string, body: string, talkingStonePassedTo: string[], abortedAt: string) => {
      const msg = messages.get(id);
      if (msg) {
        msg.status = "aborted";
        msg.body = body;
        msg.talkingStonePassedTo = talkingStonePassedTo;
      }
      abortedMessages.push({ id, body, talkingStonePassedTo, abortedAt });
    }),
    setMessageBody: vi.fn().mockResolvedValue(undefined),
    completeMessageStatus: vi.fn().mockResolvedValue(undefined),
    getMaxSequenceNum: vi.fn(async () => maxSequenceNum),
    getMessageById: vi.fn(async (id: string) => messages.get(id) ?? null),
    getMessages: vi.fn(async () => []),
    getMessagesBefore: vi.fn(async () => []),
    getMessagesAfter: vi.fn(async () => []),
    appendEvent: vi.fn(async (event: MessageEvent) => {
      events.push(event);
    }),
    getMessageEvents: vi.fn(async () => []),
    getMessageEventsByMessageIds: vi.fn(async () => []),
    getMaxEventSequenceNum: vi.fn(async () => maxEventSequenceNum),
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
    getParticipant: vi.fn(),
    getActiveParticipants: vi.fn(async () => []),
    updateParticipantLeave: vi.fn(),
    updateTokenUsage: vi.fn(async () => {}),
    updateLastReadSequenceNum: vi.fn().mockResolvedValue(undefined),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
  };
}

/** 创建 MemoryIndexGateway mock */
function mockMemoryIndex(): MemoryIndexGateway {
  return {
    indexMessage: vi.fn(),
    indexLinkedResource: vi.fn(),
    indexFeature: vi.fn(),
    indexResearch: vi.fn(),
  };
}

/** 构造一个已完成的消息实体 */
function completedMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-completed",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderType: "user",
    senderId: "user-1",
    talkingStonePassedTo: ["otter-1"],
    status: "completed",
    body: "你好",
    attachments: null,
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    createdAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** 构造一个流式消息实体 */
function streamingMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-streaming",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderType: "otter",
    senderId: "otter-1",
    talkingStonePassedTo: [],
    status: "streaming",
    body: null,
    attachments: null,
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    createdAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    ...overrides,
  };
}

describe("SendMessage", () => {
  describe("send", () => {
    it("创建已完成消息，返回 status=completed", async () => {
      const repo = mockRepo();
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      const msg = await sm.send({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: ["otter-1"],
        body: "你好",
      });

      expect(msg.status).toBe("completed");
      expect(msg.body).toBe("你好");
      expect(msg.senderType).toBe("user");
      expect(msg.conversationId).toBe("conv-1");
    });

    it("user 消息 talkingStonePassedTo 为空时抛出 validation 错误", async () => {
      const repo = mockRepo();
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      await expect(
        sm.send({
          conversationId: "conv-1",
          senderId: "user-1",
          talkingStonePassedTo: [],
          body: "你好",
        }),
      ).rejects.toThrow(DomainError);

      await expect(
        sm.send({
          conversationId: "conv-1",
          senderId: "user-1",
          talkingStonePassedTo: [],
          body: "你好",
        }),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });

    it("system 消息空 talkingStonePassedTo 可成功", async () => {
      const repo = mockRepo();
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      const msg = await sm.send({
        conversationId: "conv-1",
        senderType: "system",
        senderId: "system",
        talkingStonePassedTo: [],
        body: "系统通知",
      });

      expect(msg.status).toBe("completed");
      expect(msg.senderType).toBe("system");
    });

    it("无活跃 Turn 时自动创建新 Turn", async () => {
      const repo = mockRepo({ activeTurn: null, maxTurnNumber: 2 });
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      const msg = await sm.send({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: ["otter-1"],
        body: "你好",
      });

      /** 验证创建了新 Turn（turnNumber = maxTurnNumber + 1 = 3） */
      expect(repo._turns.length).toBeGreaterThan(0);
      const newTurn = repo._turns[repo._turns.length - 1];
      expect(newTurn.turnNumber).toBe(3);
      expect(newTurn.status).toBe("open");
      expect(msg.turnId).toBe(newTurn.id);
    });
  });

  describe("start", () => {
    it("创建流式消息，status=streaming，body=null", async () => {
      const repo = mockRepo();
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      const msg = await sm.start({
        conversationId: "conv-1",
        senderId: "otter-1",
        talkingStonePassedTo: [],
      });

      expect(msg.status).toBe("streaming");
      expect(msg.body).toBeNull();
      expect(msg.senderType).toBe("otter");
      expect(msg.completedAt).toBeNull();
    });
  });

  describe("appendEvent", () => {
    it("streaming 消息可追加事件", async () => {
      const msg = streamingMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      const event = await sm.appendEvent({
        messageId: msg.id,
        eventType: "assistant_text",
        payload: { text: "部分内容" },
      });

      expect(event.messageId).toBe(msg.id);
      expect(event.eventType).toBe("assistant_text");
      expect(repo._events).toHaveLength(1);
    });

    it("completed 消息追加事件抛出 validation 错误", async () => {
      const msg = completedMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      await expect(
        sm.appendEvent({
          messageId: msg.id,
          eventType: "assistant_text",
          payload: { text: "内容" },
        }),
      ).rejects.toThrow(DomainError);

      await expect(
        sm.appendEvent({
          messageId: msg.id,
          eventType: "assistant_text",
          payload: { text: "内容" },
        }),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });

    it("消息不存在时抛出 not_found 错误", async () => {
      const repo = mockRepo();
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      await expect(
        sm.appendEvent({
          messageId: "nonexistent",
          eventType: "assistant_text",
          payload: {},
        }),
      ).rejects.toThrow(DomainError);

      await expect(
        sm.appendEvent({
          messageId: "nonexistent",
          eventType: "assistant_text",
          payload: {},
        }),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "not_found");
    });
  });

  describe("complete", () => {
    it("streaming -> completed 并设置 body", async () => {
      const msg = streamingMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      const result = await sm.complete(msg.id, {
        body: "完整回复",
        talkingStonePassedTo: ["user-1"],
      });

      expect(result.status).toBe("completed");
      expect(result.body).toBe("完整回复");
      expect(result.talkingStonePassedTo).toEqual(["user-1"]);
      expect(repo._completedMessages).toHaveLength(1);
    });

    it("空 body 抛出 validation 错误", async () => {
      const msg = streamingMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      await expect(
        sm.complete(msg.id, {
          body: "",
          talkingStonePassedTo: ["user-1"],
        }),
      ).rejects.toThrow(DomainError);

      await expect(
        sm.complete(msg.id, {
          body: "",
          talkingStonePassedTo: ["user-1"],
        }),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });
  });

  describe("fail", () => {
    it("streaming 消息可标记失败", async () => {
      const msg = streamingMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      await sm.fail(msg.id, "出错了");

      expect(repo._failedMessages).toHaveLength(1);
      expect(repo._failedMessages[0].id).toBe(msg.id);
      expect(repo._failedMessages[0].body).toBe("出错了");
    });

    it("completed 消息标记失败抛出 validation 错误", async () => {
      const msg = completedMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      await expect(sm.fail(msg.id)).rejects.toThrow(DomainError);
      await expect(sm.fail(msg.id)).rejects.toSatisfy(
        (err: DomainError) => err.kind === "validation",
      );
    });
  });

  describe("abort", () => {
    it("streaming -> aborted 并设置 body", async () => {
      const msg = streamingMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      const result = await sm.abort(msg.id, {
        body: "中断内容",
        talkingStonePassedTo: ["user-1"],
      });

      expect(result.status).toBe("aborted");
      expect(result.body).toBe("中断内容");
      expect(repo._abortedMessages).toHaveLength(1);
    });
  });

  describe("sendSystem", () => {
    it("创建已完成的系统消息，talkingStonePassedTo 为空数组", async () => {
      const repo = mockRepo();
      const sm = new SendMessage(repo, mockMemoryIndex(), mockLogger());

      const msg = await sm.sendSystem("conv-1", "系统通知");

      expect(msg.status).toBe("completed");
      expect(msg.senderType).toBe("system");
      expect(msg.senderId).toBe("system");
      expect(msg.talkingStonePassedTo).toEqual([]);
      expect(msg.body).toBe("系统通知");
    });
  });
});
