import { describe, it, expect, vi } from "vitest";
import { SendMessage } from "@usecases/conversation/send-message";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { Logger } from "@usecases/ports/logger";
import type { ConversationParticipant, Turn } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
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
  messageList?: Message[];
  participants?: ConversationParticipant[];
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
    updatePinned: vi.fn().mockResolvedValue(undefined),
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
    startSpeaking: vi.fn(async (messageId: string, body: string, talkingStonePassedTo: string[]) => {
      const msg = messages.get(messageId);
      if (msg) {
        msg.status = "speaking";
        msg.body = body;
        msg.talkingStonePassedTo = talkingStonePassedTo;
      }
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
    failInFlightMessages: vi.fn(async () => 0),
    closeOrphanedTurns: vi.fn(async () => 0),
    abortMessage: vi.fn(async (id: string, body: string, talkingStonePassedTo: string[], abortedAt: string) => {
      const msg = messages.get(id);
      if (msg) {
        msg.status = "aborted";
        msg.body = body;
        msg.talkingStonePassedTo = talkingStonePassedTo;
      }
      abortedMessages.push({ id, body, talkingStonePassedTo, abortedAt });
    }),
    getMaxSequenceNum: vi.fn(async () => maxSequenceNum),
    getMessageById: vi.fn(async (id: string) => messages.get(id) ?? null),
    getMessages: vi.fn(async (_conversationId: string, options?: { limit?: number; senderType?: string }) => {
      let list = opts.messageList ?? [...messages.values()];
      if (options?.senderType) {
        list = list.filter((m) => m.senderType === options.senderType);
      }
      list = [...list].sort((a, b) => b.sequenceNum - a.sequenceNum);
      return list.slice(0, options?.limit ?? 50);
    }),
    getMessagesBefore: vi.fn(async () => []),
    getMessagesAfter: vi.fn(async () => []),
    appendEvent: vi.fn(async (event: MessageEvent) => {
      events.push(event);
    }),
    getMessageEvents: vi.fn(async () => []),
    getMessageEventsByMessageIds: vi.fn(async () => []),
    getMaxEventSequenceNum: vi.fn(async () => maxEventSequenceNum),
    searchMessages: vi.fn(async () => []),
    findByExternalId: vi.fn(async () => null),
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
    getActiveParticipants: vi.fn(async () => opts.participants ?? []),
    updateParticipantLeave: vi.fn(),
    updateTokenUsage: vi.fn(async () => {}),
    updateLastReadTurnNumber: vi.fn().mockResolvedValue(undefined),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    getUserReadState: vi.fn().mockResolvedValue(null),
    upsertUserReadState: vi.fn().mockResolvedValue(undefined),
    getFirstUnreadMessage: vi.fn().mockResolvedValue(null),
    getUnreadCount: vi.fn().mockResolvedValue(0),
    getLastMessage: vi.fn().mockResolvedValue(null),
    listConversationsWithMeta: vi.fn().mockResolvedValue([]),
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

/** 创建 OtterRepository mock（getById 可配置） */
function mockOtterRepo(otters: Otter[] = []): OtterRepository {
  const byId = new Map(otters.map((o) => [o.id, o]));
  return {
    createOtter: vi.fn(),
    getById: vi.fn(async (id: string) => byId.get(id) ?? null),
    dissolve: vi.fn(),
    deleteOtter: vi.fn(),
    createSession: vi.fn(),
    getActiveSession: vi.fn(async () => null),
    archiveSession: vi.fn(),
    getSessionHistory: vi.fn(async () => []),
    getSessionById: vi.fn(async () => null),
    setHandoffSummary: vi.fn(),
    restoreSessionStatus: vi.fn(),
    deleteSession: vi.fn(),
  };
}

/** 构造一个 otter 实体 */
function makeOtter(overrides: Partial<Otter> = {}): Otter {
  return {
    id: "otter-big",
    name: "大獭",
    type: "big",
    status: "active",
    role: null,
    parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z",
    dissolvedAt: null,
    ...overrides,
  };
}

/** 构造一个对话参与者实体 */
function makeParticipant(overrides: Partial<ConversationParticipant> = {}): ConversationParticipant {
  return {
    id: "p-1",
    conversationId: "conv-1",
    otterId: "otter-big",
    joinedAtTurnId: null,
    joinedAtTurnNumber: 0,
    leftAtTurnId: null,
    leftAtTurnNumber: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    leftAt: null,
    lastReadTurnNumber: 0,
    ...overrides,
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
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    source: "web",
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
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    createdAt: "2026-01-01T00:00:00Z",
    source: "web",
      completedAt: null,
    ...overrides,
  };
}

describe("SendMessage", () => {
  describe("send", () => {
    it("创建已完成消息，返回 status=completed", async () => {
      const repo = mockRepo({ participants: [makeParticipant({ otterId: "otter-1" })] });
      const sm = new SendMessage(repo, mockOtterRepo([makeOtter({ id: "otter-1" })]), mockMemoryIndex(), mockLogger());

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

    it("记忆索引写入 html-card 剥离投影（卡片源码不入索引）", async () => {
      const repo = mockRepo({ participants: [makeParticipant({ otterId: "otter-1" })] });
      /** 副作用断言：捕获实际索引的文本 */
      const indexedContents: string[] = [];
      const memoryIndex: MemoryIndexGateway = {
        indexMessage: vi.fn(async (_id: string, _convId: string, content: string) => { indexedContents.push(content); }),
        indexLinkedResource: vi.fn(),
        indexFeature: vi.fn(),
        indexResearch: vi.fn(),
      };
      const sm = new SendMessage(repo, mockOtterRepo([makeOtter({ id: "otter-1" })]), memoryIndex, mockLogger());

      await sm.send({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: ["otter-1"],
        body: '前言\n```html-card title="方案对比"\n<table/>\n```\n后记',
      });

      expect(indexedContents).toEqual(["前言\n[html-card: 方案对比]\n后记"]);
    });
  });
});

describe("SendMessage 显式目标校验（F20260728htar：在场 + otter 未解散）", () => {
  it("显式目标在场且 active：原样保留", async () => {
    const repo = mockRepo({ participants: [makeParticipant({ otterId: "otter-1" })] });
    const sm = new SendMessage(repo, mockOtterRepo([makeOtter({ id: "otter-1" })]), mockMemoryIndex(), mockLogger());

    const msg = await sm.send({
      conversationId: "conv-1",
      senderId: "user-1",
      talkingStonePassedTo: ["otter-1"],
      body: "回执",
    });

    expect(msg.talkingStonePassedTo).toEqual(["otter-1"]);
  });

  it("显式目标已解散：全部不合法退默认派发（兜底在场大獭，已解散者不被复活）", async () => {
    const repo = mockRepo({
      participants: [
        makeParticipant({ otterId: "otter-big" }),
        makeParticipant({ id: "p-2", otterId: "otter-dissolved" }),
      ],
    });
    const sm = new SendMessage(
      repo,
      mockOtterRepo([
        makeOtter({ id: "otter-big", type: "big" }),
        makeOtter({ id: "otter-dissolved", status: "dissolved", dissolvedAt: "2026-01-02T00:00:00Z" }),
      ]),
      mockMemoryIndex(),
      mockLogger(),
    );

    const msg = await sm.send({
      conversationId: "conv-1",
      senderId: "user-1",
      talkingStonePassedTo: ["otter-dissolved"],
      body: "回执",
    });

    expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
  });

  it("显式目标不在场（无参与记录）：退默认派发", async () => {
    const repo = mockRepo({ participants: [makeParticipant({ otterId: "otter-big" })] });
    const sm = new SendMessage(
      repo,
      mockOtterRepo([makeOtter({ id: "otter-big", type: "big" })]),
      mockMemoryIndex(),
      mockLogger(),
    );

    const msg = await sm.send({
      conversationId: "conv-1",
      senderId: "user-1",
      talkingStonePassedTo: ["otter-ghost"],
      body: "回执",
    });

    expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
  });

  it("部分目标不合法：过滤后保留合法目标，不退默认派发", async () => {
    const repo = mockRepo({
      participants: [
        makeParticipant({ otterId: "otter-1" }),
        makeParticipant({ id: "p-2", otterId: "otter-dissolved" }),
      ],
    });
    const sm = new SendMessage(
      repo,
      mockOtterRepo([
        makeOtter({ id: "otter-1" }),
        makeOtter({ id: "otter-dissolved", status: "dissolved", dissolvedAt: "2026-01-02T00:00:00Z" }),
      ]),
      mockMemoryIndex(),
      mockLogger(),
    );

    const msg = await sm.send({
      conversationId: "conv-1",
      senderId: "user-1",
      talkingStonePassedTo: ["otter-1", "otter-dissolved"],
      body: "回执",
    });

    expect(msg.talkingStonePassedTo).toEqual(["otter-1"]);
  });

  it("system 消息豁免校验：显式目标不在场也原样保留（定时任务链不改派）", async () => {
    const repo = mockRepo();
    const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

    const msg = await sm.send({
      conversationId: "conv-1",
      senderType: "system",
      senderId: "system",
      talkingStonePassedTo: ["otter-dissolved"],
      body: "定时任务触发",
    });

    expect(msg.talkingStonePassedTo).toEqual(["otter-dissolved"]);
  });
});

describe("SendMessage 默认目标解析（无 @）", () => {
  describe("send", () => {
    it("user 消息空目标时解析默认派发：优先最后发言的在场 otter", async () => {
      const lastMsg = completedMessage({
        id: "msg-otter-last",
        senderType: "otter",
        senderId: "otter-small",
        sequenceNum: 5,
      });
      const repo = mockRepo({
        messageList: [lastMsg],
        participants: [
          makeParticipant({ otterId: "otter-big" }),
          makeParticipant({ id: "p-2", otterId: "otter-small" }),
        ],
      });
      const sm = new SendMessage(
        repo,
        mockOtterRepo([makeOtter({ id: "otter-small", name: "小獭", type: "small" })]),
        mockMemoryIndex(),
        mockLogger(),
      );

      const msg = await sm.send({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: [],
        body: "继续",
      });

      expect(msg.talkingStonePassedTo).toEqual(["otter-small"]);
    });

    it("user 消息空目标时：最后发言的 otter 消息为 failed 也算发言", async () => {
      const failedMsg = completedMessage({
        id: "msg-otter-failed",
        senderType: "otter",
        senderId: "otter-small",
        status: "failed",
        sequenceNum: 5,
      });
      const repo = mockRepo({
        messageList: [failedMsg],
        participants: [
          makeParticipant({ otterId: "otter-big" }),
          makeParticipant({ id: "p-2", otterId: "otter-small" }),
        ],
      });
      const sm = new SendMessage(
        repo,
        mockOtterRepo([makeOtter({ id: "otter-small", name: "小獭", type: "small" })]),
        mockMemoryIndex(),
        mockLogger(),
      );

      const msg = await sm.send({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: [],
        body: "继续",
      });

      expect(msg.talkingStonePassedTo).toEqual(["otter-small"]);
    });

    it("user 消息空目标时：最后发言者在场但已解散则兜底大獭", async () => {
      const lastMsg = completedMessage({
        id: "msg-otter-dissolved",
        senderType: "otter",
        senderId: "otter-dissolved",
        sequenceNum: 5,
      });
      const repo = mockRepo({
        messageList: [lastMsg],
        participants: [
          makeParticipant({ otterId: "otter-big" }),
          makeParticipant({ id: "p-2", otterId: "otter-dissolved" }),
        ],
      });
      const sm = new SendMessage(
        repo,
        mockOtterRepo([
          makeOtter({ id: "otter-big", type: "big" }),
          makeOtter({ id: "otter-dissolved", name: "小獭", type: "small", status: "dissolved", dissolvedAt: "2026-01-02T00:00:00Z" }),
        ]),
        mockMemoryIndex(),
        mockLogger(),
      );

      const msg = await sm.send({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: [],
        body: "继续",
      });

      expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("user 消息空目标时：最后发言者已退场则兜底大獭", async () => {
      const lastMsg = completedMessage({
        id: "msg-otter-left",
        senderType: "otter",
        senderId: "otter-left",
        sequenceNum: 5,
      });
      const repo = mockRepo({
        messageList: [lastMsg],
        participants: [makeParticipant({ otterId: "otter-big" })],
      });
      const sm = new SendMessage(
        repo,
        mockOtterRepo([makeOtter({ id: "otter-big", type: "big" })]),
        mockMemoryIndex(),
        mockLogger(),
      );

      const msg = await sm.send({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: [],
        body: "你好",
      });

      expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("user 消息空目标且无 otter 发言过时兜底大獭", async () => {
      const repo = mockRepo({
        participants: [makeParticipant({ otterId: "otter-big" })],
      });
      const sm = new SendMessage(
        repo,
        mockOtterRepo([makeOtter({ id: "otter-big", type: "big" })]),
        mockMemoryIndex(),
        mockLogger(),
      );

      const msg = await sm.send({
        conversationId: "conv-1",
        senderId: "user-1",
        talkingStonePassedTo: [],
        body: "你好",
      });

      expect(msg.talkingStonePassedTo).toEqual(["otter-big"]);
    });

    it("user 消息空目标时无法解析（无最后发言者、无大獭）抛出 validation 错误", async () => {
      const repo = mockRepo();
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

      await expect(
        sm.send({
          conversationId: "conv-1",
          senderId: "user-1",
          talkingStonePassedTo: [],
          body: "你好",
        }),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });
  });
});

describe("SendMessage", () => {
  describe("send（system 与 Turn）", () => {
    it("system 消息空 talkingStonePassedTo 可成功", async () => {
      const repo = mockRepo();
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

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
      const repo = mockRepo({ activeTurn: null, maxTurnNumber: 2, participants: [makeParticipant({ otterId: "otter-1" })] });
      const sm = new SendMessage(repo, mockOtterRepo([makeOtter({ id: "otter-1" })]), mockMemoryIndex(), mockLogger());

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
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

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
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

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
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

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
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

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
    it("speaking -> completed 并设置 body", async () => {
      const msg = streamingMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

      // 先调用 startSpeaking 将消息转为 speaking 状态
      await sm.startSpeaking(msg.id, { body: "完整回复", talkingStonePassedTo: ["user-1"] });

      const result = await sm.complete(msg.id);

      expect(result.message.status).toBe("completed");
      expect(result.message.body).toBe("完整回复");
      expect(result.message.talkingStonePassedTo).toEqual(["user-1"]);
      expect(repo._completedMessages).toHaveLength(1);
    });

    it("空 body 抛出 validation 错误", async () => {
      const msg = streamingMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

      // startSpeaking 时就会校验 body 非空
      await expect(
        sm.startSpeaking(msg.id, { body: "", talkingStonePassedTo: ["user-1"] }),
      ).rejects.toThrow(DomainError);

      await expect(
        sm.startSpeaking(msg.id, { body: "", talkingStonePassedTo: ["user-1"] }),
      ).rejects.toSatisfy((err: DomainError) => err.kind === "validation");
    });
  });

  describe("fail", () => {
    it("streaming 消息可标记失败", async () => {
      const msg = streamingMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

      await sm.fail(msg.id, "出错了");

      expect(repo._failedMessages).toHaveLength(1);
      expect(repo._failedMessages[0].id).toBe(msg.id);
      expect(repo._failedMessages[0].body).toBe("出错了");
    });

    it("completed 消息标记失败抛出 validation 错误", async () => {
      const msg = completedMessage();
      const repo = mockRepo({ messages: new Map([[msg.id, msg]]) });
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

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
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

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
      const sm = new SendMessage(repo, mockOtterRepo(), mockMemoryIndex(), mockLogger());

      const msg = await sm.sendSystem("conv-1", "系统通知");

      expect(msg.status).toBe("completed");
      expect(msg.senderType).toBe("system");
      expect(msg.senderId).toBe("system");
      expect(msg.talkingStonePassedTo).toEqual([]);
      expect(msg.body).toBe("系统通知");
    });
  });
});
