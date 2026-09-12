import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Conversation, Turn } from "@entities/conversation/conversation";
import type { Entry } from "@entities/conversation/entry";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";

/** 创建内存 SQLite 数据库并初始化 schema */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
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
    workspaceDir: null,
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

describe("SqliteConversationRepository - listConversationsWithMeta 活动状态派生（F20260805actv；批4c 切 entries/invokes）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let entryRepo: SqliteEntryRepository;
  let invokeRepo: SqliteInvokeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    entryRepo = new SqliteEntryRepository(db);
    invokeRepo = new SqliteInvokeRepository(db);
    new SqliteOtterRepository(db).createOtter({
      id: "otter-1", name: "小獭", type: "small", status: "active",
      role: null, parentOtterId: null,
      createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  function entryFixture(overrides: Partial<Entry> = {}): Entry {
    const id = overrides.id ?? "entry-1";
    return {
      id, conversationId: "conv-1", sequenceNum: 0,
      entryType: "speak", senderType: "otter", senderId: "otter-1",
      body: "气泡内容", invokeId: null, yieldTargets: null,
      turnId: "turn-1", status: "completed",
      source: null, metadata: null, senderName: "otter",
      contextTokens: null, contextTokensMax: null,
      createdAt: "2026-07-22T00:00:00Z", completedAt: "2026-07-22T00:00:00Z",
      ...overrides,
    };
  }

  it("存在 running invoke 时派生为 processing", async () => {
    await repo.create(conversationFixture());
    await repo.createTurn(turnFixture());
    await invokeRepo.createInvoke({
      id: "inv-1", conversationId: "conv-1", otterId: "otter-1", turnId: "turn-1",
      status: "running", triggerType: "user_message", triggerSource: "web",
      toolCallCount: 0, tokenUsage: null, talkingStonePassedTo: null,
      startedAt: "2026-07-22T00:00:00Z", endedAt: null,
    } as never);

    const [item] = await repo.listConversationsWithMeta("user-1");
    expect(item.activityStatus).toBe("processing");
  });

  it("active 对话 + 仅有 completed entries → awaiting_user", async () => {
    await repo.create(conversationFixture());
    await repo.createTurn(turnFixture());
    await entryRepo.createEntryAtomic(entryFixture({ yieldTargets: ["user"] }));

    const [item] = await repo.listConversationsWithMeta("user-1");
    expect(item.activityStatus).toBe("awaiting_user");
  });

  it("active 对话 + 无任何 entry → idle", async () => {
    await repo.create(conversationFixture());

    const [item] = await repo.listConversationsWithMeta("user-1");
    expect(item.activityStatus).toBe("idle");
  });

  it("completed 对话即使有 entries 也派生为 idle", async () => {
    await repo.create(conversationFixture({ status: "completed", completedAt: "2026-07-22T01:00:00Z" }));
    await repo.createTurn(turnFixture());
    await entryRepo.createEntryAtomic(entryFixture());

    const [item] = await repo.listConversationsWithMeta("user-1");
    expect(item.activityStatus).toBe("idle");
  });

  it("未读计数按 speak/system entries 计（跳过 user 气泡）", async () => {
    await repo.create(conversationFixture());
    await repo.createTurn(turnFixture());
    await entryRepo.createEntryAtomic(entryFixture({ id: "e-1", entryType: "user", senderType: "user", senderId: "user-1", body: "用户发言" }));
    await entryRepo.createEntryAtomic(entryFixture({ id: "e-2", entryType: "speak" }));
    await entryRepo.createEntryAtomic(entryFixture({ id: "e-3", entryType: "system", senderType: "system", senderId: "system", body: "系统条目" }));

    const [item] = await repo.listConversationsWithMeta("user-1");
    expect(item.unreadCount).toBe(2);
  });

  it("多对话并发时各自独立派生状态", async () => {
    await repo.create(conversationFixture({ id: "conv-a", createdAt: "2026-07-22T00:00:00Z" }));
    await repo.createTurn(turnFixture({ id: "turn-a", conversationId: "conv-a" }));
    await invokeRepo.createInvoke({
      id: "inv-a", conversationId: "conv-a", otterId: "otter-1", turnId: "turn-a",
      status: "running", triggerType: "user_message", triggerSource: "web",
      toolCallCount: 0, tokenUsage: null, talkingStonePassedTo: null,
      startedAt: "2026-07-22T00:00:00Z", endedAt: null,
    } as never);

    await repo.create(conversationFixture({ id: "conv-b", createdAt: "2026-07-22T00:01:00Z" }));
    await repo.createTurn(turnFixture({ id: "turn-b", conversationId: "conv-b" }));
    await entryRepo.createEntryAtomic(entryFixture({ id: "e-b", conversationId: "conv-b", turnId: "turn-b" }));

    await repo.create(conversationFixture({ id: "conv-c", createdAt: "2026-07-22T00:02:00Z" }));

    const items = await repo.listConversationsWithMeta("user-1");
    const byId = Object.fromEntries(items.map(i => [i.id, i.activityStatus]));
    expect(byId["conv-a"]).toBe("processing");
    expect(byId["conv-b"]).toBe("awaiting_user");
    expect(byId["conv-c"]).toBe("idle");
  });
});
