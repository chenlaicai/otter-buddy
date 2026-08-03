import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Conversation, Turn } from "@entities/conversation/conversation";
import type { Message, MessageEvent } from "@entities/conversation/message";

/** 创建内存 SQLite 数据库并初始化 schema */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  // 添加 source 列（模拟 migration）
  db.prepare("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'web'").run();
  return db;
}

/** 插入 otter 记录（外键依赖） */
function insertOtter(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO otters (id, name, type, created_at)
    VALUES (?, 'test-otter', 'assistant', '2026-07-22T00:00:00Z')
  `).run(id);
}

/** 构造测试用 Conversation 实体 */
function conversationFixture(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "测试对话",
    status: "active",
    summary: null,
    pinned: false,
    createdAt: "2026-07-22T00:00:00Z",
    updatedAt: "2026-07-22T00:00:00Z",
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

/** 构造测试用 Turn 实体 */
function turnFixture(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    conversationId: "conv-1",
    turnNumber: 1,
    status: "open",
    createdAt: "2026-07-22T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

/** 构造测试用 Message 实体 */
function messageFixture(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderType: "user",
    senderId: "user-1",
    talkingStonePassedTo: ["otter-1"],
    status: "completed",
    body: "你好，请帮我分析一下数据",
    sequenceNum: 1,
    contextTokens: null,
    contextTokensMax: null,
    source: "web",
    createdAt: "2026-07-22T00:01:00Z",
    completedAt: "2026-07-22T00:01:00Z",
    ...overrides,
  };
}

/** 构造测试用 MessageEvent 实体 */
function messageEventFixture(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    id: "event-1",
    messageId: "msg-1",
    eventType: "assistant_text",
    payload: { text: "这是助手的回复" },
    sequenceNum: 1,
    createdAt: "2026-07-22T00:01:30Z",
    ...overrides,
  };
}

describe("SqliteConversationRepository - 对话与 Turn 基础操作", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("create + getById", () => {
    it("创建对话后读取，所有字段保持一致", async () => {
      await repo.create(conversationFixture());

      const result = await repo.getById("conv-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("conv-1");
      expect(result!.title).toBe("测试对话");
      expect(result!.status).toBe("active");
      expect(result!.summary).toBeNull();
      expect(result!.createdAt).toBe("2026-07-22T00:00:00Z");
      expect(result!.updatedAt).toBe("2026-07-22T00:00:00Z");
      expect(result!.completedAt).toBeNull();
      expect(result!.archivedAt).toBeNull();
    });

    it("创建对话时关联 otterIds", async () => {
      insertOtter(db, "otter-1");
      insertOtter(db, "otter-2");

      await repo.create(conversationFixture(), ["otter-1", "otter-2"]);

      const otterIds = await repo.getOtterIds("conv-1");
      expect(otterIds).toHaveLength(2);
      expect(otterIds).toContain("otter-1");
      expect(otterIds).toContain("otter-2");
    });

    it("不存在的对话返回 null", async () => {
      const result = await repo.getById("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("updateStatus", () => {
    it("将对话状态更新为 completed 并设置 completedAt", async () => {
      await repo.create(conversationFixture());

      await repo.updateStatus("conv-1", "completed", "2026-07-22T10:00:00Z");

      const result = await repo.getById("conv-1");
      expect(result!.status).toBe("completed");
      expect(result!.completedAt).toBe("2026-07-22T10:00:00Z");
      expect(result!.updatedAt).toBe("2026-07-22T10:00:00Z");
    });

    it("将对话状态更新为 archived 并设置 archivedAt", async () => {
      await repo.create(conversationFixture({ status: "completed", completedAt: "2026-07-22T10:00:00Z" }));

      await repo.updateStatus("conv-1", "archived", "2026-07-22T12:00:00Z");

      const result = await repo.getById("conv-1");
      expect(result!.status).toBe("archived");
      expect(result!.archivedAt).toBe("2026-07-22T12:00:00Z");
    });

    it("不支持的状态转换抛出异常", async () => {
      await repo.create(conversationFixture());

      await expect(repo.updateStatus("conv-1", "active" as any, "2026-07-22T10:00:00Z")).rejects.toThrow();
    });
  });

  describe("updatePinned + getAllIds 排序", () => {
    it("updatePinned 更新 pinned 状态", async () => {
      await repo.create(conversationFixture());

      await repo.updatePinned("conv-1", true);
      expect((await repo.getById("conv-1"))!.pinned).toBe(true);

      await repo.updatePinned("conv-1", false);
      expect((await repo.getById("conv-1"))!.pinned).toBe(false);
    });

    it("getAllIds 按 pinned DESC, created_at DESC 排序", async () => {
      await repo.create(conversationFixture({ id: "conv-a", createdAt: "2026-07-01T00:00:00Z" }));
      await repo.create(conversationFixture({ id: "conv-b", createdAt: "2026-07-02T00:00:00Z" }));
      await repo.create(conversationFixture({ id: "conv-c", createdAt: "2026-07-03T00:00:00Z" }));

      await repo.updatePinned("conv-a", true);

      const ids = await repo.getAllIds();
      expect(ids[0]).toBe("conv-a");
      expect(ids[1]).toBe("conv-c");
      expect(ids[2]).toBe("conv-b");
    });
  });

  describe("getActiveTurn", () => {
    it("无 turn 时返回 null", async () => {
      await repo.create(conversationFixture());

      const result = await repo.getActiveTurn("conv-1");
      expect(result).toBeNull();
    });
  });

  describe("createTurn + getActiveTurn", () => {
    it("创建 turn 后可查询到 open 状态的 turn", async () => {
      await repo.create(conversationFixture());

      const turn = turnFixture();
      await repo.createTurn(turn);

      const result = await repo.getActiveTurn("conv-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("turn-1");
      expect(result!.conversationId).toBe("conv-1");
      expect(result!.turnNumber).toBe(1);
      expect(result!.status).toBe("open");
      expect(result!.closedAt).toBeNull();
    });

    it("多个 turn 时返回最新的 open turn", async () => {
      await repo.create(conversationFixture());

      await repo.createTurn(turnFixture({ id: "turn-1", turnNumber: 1 }));
      // 先关闭 turn-1
      await repo.closeTurn("turn-1", "2026-07-22T01:00:00Z");
      // 再创建 turn-2
      await repo.createTurn(turnFixture({ id: "turn-2", turnNumber: 2 }));

      const result = await repo.getActiveTurn("conv-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("turn-2");
    });
  });

  describe("closeTurn", () => {
    it("关闭 turn 后状态变为 closed", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());

      await repo.closeTurn("turn-1", "2026-07-22T01:00:00Z");

      // 关闭后不再是 active turn
      const activeTurn = await repo.getActiveTurn("conv-1");
      expect(activeTurn).toBeNull();
    });
  });
});

describe("SqliteConversationRepository - 消息与事件操作", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("createCompletedMessage + getMessageById", () => {
    it("创建已完成消息后可查询到", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());

      const message = messageFixture();
      await repo.createCompletedMessage(message);

      const result = await repo.getMessageById("msg-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("msg-1");
      expect(result!.conversationId).toBe("conv-1");
      expect(result!.turnId).toBe("turn-1");
      expect(result!.senderType).toBe("user");
      expect(result!.senderId).toBe("user-1");
      expect(result!.status).toBe("completed");
      expect(result!.body).toBe("你好，请帮我分析一下数据");
      expect(result!.sequenceNum).toBe(1);
      expect(result!.talkingStonePassedTo).toEqual(["otter-1"]);
    });

    it("不存在的消息返回 null", async () => {
      const result = await repo.getMessageById("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createStreamingMessage", () => {
    it("创建流式消息，状态为 streaming", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());

      const message = messageFixture({
        id: "msg-streaming",
        body: null,
        talkingStonePassedTo: null,
        source: "web",
      completedAt: null,
        status: "streaming",
      });
      await repo.createStreamingMessage(message);

      const result = await repo.getMessageById("msg-streaming");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("streaming");
      expect(result!.body).toBeNull();
      expect(result!.talkingStonePassedTo).toBeNull();
    });
  });

  describe("completeMessage", () => {
    it("将 speaking 状态的消息转为 completed", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());

      await repo.createStreamingMessage(messageFixture({
        id: "msg-streaming",
        body: null,
        talkingStonePassedTo: null,
        source: "web",
      completedAt: null,
        status: "streaming",
      }));

      // 先调用 startSpeaking 将消息转为 speaking 状态
      await repo.startSpeaking("msg-streaming", "助手的完整回复内容", ["otter-1"]);

      await repo.completeMessage({
        messageId: "msg-streaming",
        body: "助手的完整回复内容",
        talkingStonePassedTo: ["otter-1"],
        completedAt: "2026-07-22T00:02:00Z",
        contextTokens: 150,
        contextTokensMax: 4096,
      });

      const result = await repo.getMessageById("msg-streaming");
      expect(result!.status).toBe("completed");
      expect(result!.body).toBe("助手的完整回复内容");
      expect(result!.talkingStonePassedTo).toEqual(["otter-1"]);
      expect(result!.contextTokens).toBe(150);
      expect(result!.contextTokensMax).toBe(4096);
    });

    it("对非 speaking 状态的消息调用 completeMessage 抛出异常", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createCompletedMessage(messageFixture());

      await expect(repo.completeMessage({
        messageId: "msg-1",
        body: "新内容",
        talkingStonePassedTo: ["otter-1"],
        completedAt: "2026-07-22T00:02:00Z",
      })).rejects.toThrow(/not found or not in speaking status/);
    });
  });
});

describe("SqliteConversationRepository - 消息状态转换与查询", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("failMessage", () => {
    it("将 streaming 状态的消息标记为 failed", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createStreamingMessage(messageFixture({
        id: "msg-streaming",
        body: null,
        talkingStonePassedTo: null,
        source: "web",
      completedAt: null,
        status: "streaming",
      }));

      await repo.failMessage("msg-streaming", "2026-07-22T00:02:00Z");

      const result = await repo.getMessageById("msg-streaming");
      expect(result!.status).toBe("failed");
      expect(result!.completedAt).toBe("2026-07-22T00:02:00Z");
    });

    it("对非 streaming/speaking 状态的消息调用 failMessage 抛出异常", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createCompletedMessage(messageFixture());

      await expect(repo.failMessage("msg-1", "2026-07-22T00:02:00Z")).rejects.toThrow(
        /not found or not in streaming\/speaking status/,
      );
    });
  });
});

describe("SqliteConversationRepository - 中止/查询/重启兜底（F20260724cwgn）", () => {
  let db: ReturnType<typeof createTestDb>;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("abortMessage", () => {
    it("将 streaming 状态的消息标记为 aborted", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createStreamingMessage(messageFixture({
        id: "msg-streaming",
        body: null,
        talkingStonePassedTo: null,
        source: "web",
      completedAt: null,
        status: "streaming",
      }));

      await repo.abortMessage("msg-streaming", "中止内容", ["otter-1"], "2026-07-22T00:02:00Z");

      const result = await repo.getMessageById("msg-streaming");
      expect(result!.status).toBe("aborted");
      expect(result!.body).toBe("中止内容");
      expect(result!.talkingStonePassedTo).toEqual(["otter-1"]);
      expect(result!.completedAt).toBe("2026-07-22T00:02:00Z");
    });

    it("对非 streaming/speaking 状态的消息调用 abortMessage 抛出异常", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createCompletedMessage(messageFixture());

      await expect(repo.abortMessage("msg-1", "中止", [], "2026-07-22T00:02:00Z")).rejects.toThrow(
        /not found or not in streaming\/speaking status/,
      );
    });
  });

  describe("getMessages", () => {
    it("返回指定对话的消息列表", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());

      await repo.createCompletedMessage(messageFixture({ id: "msg-1", sequenceNum: 1 }));
      await repo.createCompletedMessage(messageFixture({ id: "msg-2", sequenceNum: 2 }));
      await repo.createCompletedMessage(messageFixture({ id: "msg-3", sequenceNum: 3 }));

      const results = await repo.getMessages("conv-1", { limit: 10 });
      // 按 sequence_num DESC 排序
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe("msg-3");
      expect(results[1].id).toBe("msg-2");
      expect(results[2].id).toBe("msg-1");
    });

    it("按 status 过滤消息", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());

      await repo.createCompletedMessage(messageFixture({ id: "msg-completed", sequenceNum: 1, status: "completed" }));
      await repo.createStreamingMessage(messageFixture({ id: "msg-streaming", sequenceNum: 2, status: "streaming", body: null, talkingStonePassedTo: null, completedAt: null }));

      const results = await repo.getMessages("conv-1", { limit: 10, status: "completed" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("msg-completed");
    });

    it("按 senderType 过滤消息（取最后一条 otter 消息）", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());

      await repo.createCompletedMessage(messageFixture({ id: "msg-otter-old", senderType: "otter", senderId: "otter-1", sequenceNum: 1 }));
      await repo.createCompletedMessage(messageFixture({ id: "msg-user", senderType: "user", senderId: "user-1", sequenceNum: 2 }));
      await repo.createCompletedMessage(messageFixture({ id: "msg-otter-last", senderType: "otter", senderId: "otter-2", sequenceNum: 3 }));
      await repo.createCompletedMessage(messageFixture({ id: "msg-system", senderType: "system", senderId: "system", sequenceNum: 4 }));

      const results = await repo.getMessages("conv-1", { limit: 1, senderType: "otter" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("msg-otter-last");
    });

    it("按 turnId 过滤消息", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture({ id: "turn-1" }));
      await repo.createTurn(turnFixture({ id: "turn-2", turnNumber: 2 }));

      await repo.createCompletedMessage(messageFixture({ id: "msg-t1", turnId: "turn-1", sequenceNum: 1 }));
      await repo.createCompletedMessage(messageFixture({ id: "msg-t2", turnId: "turn-2", sequenceNum: 2 }));

      const results = await repo.getMessages("conv-1", { limit: 10, turnId: "turn-1" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("msg-t1");
    });

    it("使用 before 参数分页", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());

      await repo.createCompletedMessage(messageFixture({ id: "msg-1", sequenceNum: 1 }));
      await repo.createCompletedMessage(messageFixture({ id: "msg-2", sequenceNum: 2 }));
      await repo.createCompletedMessage(messageFixture({ id: "msg-3", sequenceNum: 3 }));

      // 获取 msg-3 之前的消息
      const results = await repo.getMessages("conv-1", { limit: 10, before: "msg-3" });
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("msg-2");
      expect(results[1].id).toBe("msg-1");
    });
  });

  describe("appendEvent + getMessageEvents", () => {
    it("追加事件后可查询到", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createCompletedMessage(messageFixture());

      const event = messageEventFixture();
      await repo.appendEvent(event);

      const results = await repo.getMessageEvents("msg-1");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("event-1");
      expect(results[0].messageId).toBe("msg-1");
      expect(results[0].eventType).toBe("assistant_text");
      expect(results[0].payload).toEqual({ text: "这是助手的回复" });
      expect(results[0].sequenceNum).toBe(1);
    });

    it("多个事件按 sequence_num 正序返回", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createCompletedMessage(messageFixture());

      await repo.appendEvent(messageEventFixture({
        id: "event-2",
        sequenceNum: 2,
        eventType: "tool_result",
        payload: { tool: "search", result: "found" },
      }));
      await repo.appendEvent(messageEventFixture({
        id: "event-1",
        sequenceNum: 1,
        eventType: "assistant_text",
        payload: { text: "先执行搜索" },
      }));

      const results = await repo.getMessageEvents("msg-1");
      expect(results).toHaveLength(2);
      // 按 sequence_num ASC 排序
      expect(results[0].id).toBe("event-1");
      expect(results[1].id).toBe("event-2");
    });

    it("无事件时返回空数组", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createCompletedMessage(messageFixture());

      const results = await repo.getMessageEvents("msg-1");
      expect(results).toEqual([]);
    });
  });
});

describe("SqliteConversationRepository - 重启兜底与未读过滤（F20260724cwgn）", () => {
  let db: ReturnType<typeof createTestDb>;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("failInFlightMessages（服务重启兜底）", () => {
    it("将所有 streaming/speaking 消息标记为 failed，streaming 写入失败说明、speaking 保留已有 body", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createStreamingMessage(messageFixture({
        id: "msg-streaming",
        body: null,
        talkingStonePassedTo: null,
        source: "web",
      completedAt: null,
        status: "streaming",
      }));
      await repo.createStreamingMessage(messageFixture({
        id: "msg-speaking",
        body: null,
        talkingStonePassedTo: null,
        source: "web",
      completedAt: null,
        status: "streaming",
        sequenceNum: 2,
      }));
      await repo.startSpeaking("msg-speaking", "发言到一半的正文", ["user-1"]);
      await repo.createCompletedMessage(messageFixture({ id: "msg-done", sequenceNum: 3 }));

      const count = await repo.failInFlightMessages("2026-07-24T00:02:00Z", "[服务重启，发言中断]");

      expect(count).toBe(2);
      const streaming = await repo.getMessageById("msg-streaming");
      expect(streaming!.status).toBe("failed");
      expect(streaming!.body).toBe("[服务重启，发言中断]");
      expect(streaming!.completedAt).toBe("2026-07-24T00:02:00Z");
      const speaking = await repo.getMessageById("msg-speaking");
      expect(speaking!.status).toBe("failed");
      /** speaking 保留已有 body 但加中断标记前缀（F5：避免半截 body 被当作完整发言） */
      expect(speaking!.body).toBe("[服务重启，发言中断]\n\n发言到一半的正文");
      const done = await repo.getMessageById("msg-done");
      expect(done!.status).toBe("completed");
    });

    it("无进行中消息时返回 0", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createCompletedMessage(messageFixture());

      expect(await repo.failInFlightMessages("2026-07-24T00:02:00Z", "[服务重启，发言中断]")).toBe(0);
    });
  });

  describe("closeOrphanedTurns（服务重启兜底，F4）", () => {
    it("关闭不再有进行中消息的 open turn，保留含进行中消息的 turn", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture({ id: "turn-orphan" }));
      await repo.createCompletedMessage(messageFixture({ turnId: "turn-orphan" }));
      await repo.createTurn(turnFixture({ id: "turn-active", turnNumber: 2 }));
      await repo.createStreamingMessage(messageFixture({
        id: "msg-inflight",
        turnId: "turn-active",
        sequenceNum: 2,
        body: null,
        talkingStonePassedTo: null,
        source: "web",
      completedAt: null,
        status: "streaming",
      }));

      const count = await repo.closeOrphanedTurns("2026-07-24T00:03:00Z");

      expect(count).toBe(1);
      expect(await repo.getActiveTurn("conv-1")).not.toBeNull();
      expect((await repo.getActiveTurn("conv-1"))!.id).toBe("turn-active");
    });

    it("全部 turn 无进行中消息时全部关闭", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      await repo.createCompletedMessage(messageFixture());

      expect(await repo.closeOrphanedTurns("2026-07-24T00:03:00Z")).toBe(1);
      expect(await repo.getActiveTurn("conv-1")).toBeNull();
    });
  });

  describe("getUnreadMessages（F5：排除进行中半成品）", () => {
    it("不返回 streaming/speaking 消息（半成品不应注入其它 otter 上下文）", async () => {
      await repo.create(conversationFixture());
      await repo.createTurn(turnFixture());
      /** conversation_participants 有 otter_id 外键，需先插入 otter */
      db.prepare(`INSERT INTO otters (id, name, type) VALUES (?, ?, ?)`).run("otter-reader", "Reader", "small");
      await repo.createParticipant({
        id: "part-1", conversationId: "conv-1", otterId: "otter-reader",
        joinedAtTurnId: null, joinedAtTurnNumber: 0,
        leftAtTurnId: null, leftAtTurnNumber: null,
        status: "active", createdAt: "2026-07-22T00:00:00Z", leftAt: null,
        lastReadTurnNumber: 0,
      });
      await repo.createCompletedMessage(messageFixture({ senderId: "otter-1" }));
      await repo.createStreamingMessage(messageFixture({
        id: "msg-inflight", senderId: "otter-1", sequenceNum: 2,
        body: null, talkingStonePassedTo: null, source: "web",
      completedAt: null, status: "streaming",
      }));

      const unread = await repo.getUnreadMessages("conv-1", "otter-reader");
      expect(unread.map(m => m.id)).toEqual(["msg-1"]);
    });
  });
});
