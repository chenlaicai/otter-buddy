import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Conversation } from "@entities/conversation/conversation";
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


describe("SqliteConversationRepository - 对话基础操作", () => {
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

  afterEach(() => {
    db.close();
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
      status: "completed",
      source: null, metadata: null, senderName: "otter",
      contextTokens: null, contextTokensMax: null,
      createdAt: "2026-07-22T00:00:00Z", completedAt: "2026-07-22T00:00:00Z",
      ...overrides,
    };
  }

  it("存在 running invoke 时派生为 processing", async () => {
    await repo.create(conversationFixture());
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
    await entryRepo.createEntryAtomic(entryFixture());

    const [item] = await repo.listConversationsWithMeta("user-1");
    expect(item.activityStatus).toBe("idle");
  });

  it("未读计数按 speak/system entries 计（跳过 user 气泡）", async () => {
    await repo.create(conversationFixture());
    await entryRepo.createEntryAtomic(entryFixture({ id: "e-1", entryType: "user", senderType: "user", senderId: "user-1", body: "用户发言" }));
    await entryRepo.createEntryAtomic(entryFixture({ id: "e-2", entryType: "speak" }));
    await entryRepo.createEntryAtomic(entryFixture({ id: "e-3", entryType: "system", senderType: "system", senderId: "system", body: "系统条目" }));

    const [item] = await repo.listConversationsWithMeta("user-1");
    expect(item.unreadCount).toBe(2);
  });

  it("多对话并发时各自独立派生状态", async () => {
    await repo.create(conversationFixture({ id: "conv-a", createdAt: "2026-07-22T00:00:00Z" }));
    await invokeRepo.createInvoke({
      id: "inv-a", conversationId: "conv-a", otterId: "otter-1", turnId: "turn-a",
      status: "running", triggerType: "user_message", triggerSource: "web",
      toolCallCount: 0, tokenUsage: null, talkingStonePassedTo: null,
      startedAt: "2026-07-22T00:00:00Z", endedAt: null,
    } as never);

    await repo.create(conversationFixture({ id: "conv-b", createdAt: "2026-07-22T00:01:00Z" }));
    await entryRepo.createEntryAtomic(entryFixture({ id: "e-b", conversationId: "conv-b" }));

    await repo.create(conversationFixture({ id: "conv-c", createdAt: "2026-07-22T00:02:00Z" }));

    const items = await repo.listConversationsWithMeta("user-1");
    const byId = Object.fromEntries(items.map(i => [i.id, i.activityStatus]));
    expect(byId["conv-a"]).toBe("processing");
    expect(byId["conv-b"]).toBe("awaiting_user");
    expect(byId["conv-c"]).toBe("idle");
  });
});

describe("SqliteConversationRepository - listConversationsWithMeta 标题搜索（F20260916lpsc）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    await repo.create(conversationFixture({ id: "conv-1", title: "工作区优化讨论", createdAt: "2026-07-22T00:00:00Z" }));
    await repo.create(conversationFixture({ id: "conv-2", title: "记忆搜索方案", createdAt: "2026-07-22T00:01:00Z" }));
    await repo.create(conversationFixture({ id: "conv-3", title: "50% 进度报告", createdAt: "2026-07-22T00:02:00Z" }));
    await repo.create(conversationFixture({ id: "conv-4", title: "已归档的工作区对话", status: "archived", archivedAt: "2026-07-22T01:00:00Z", createdAt: "2026-07-22T00:03:00Z" }));
  });

  afterEach(() => {
    db.close();
  });

  it("search 关键字按标题子串过滤", async () => {
    const items = await repo.listConversationsWithMeta("user-1", { search: "工作区" });
    expect(items.map(i => i.id)).toEqual(["conv-1"]);
  });

  it("search 不命中的归档对话不返回", async () => {
    // conv-4 标题含「工作区」但已归档——archived 排除规则优先
    const items = await repo.listConversationsWithMeta("user-1", { search: "已归档" });
    expect(items).toEqual([]);
  });

  it("search 中的 LIKE 通配符 % 被转义为字面量", async () => {
    // 「50%」若未转义会命中所有含「50」的标题；转义后仅精确命中 conv-3
    const items = await repo.listConversationsWithMeta("user-1", { search: "50%" });
    expect(items.map(i => i.id)).toEqual(["conv-3"]);
  });

  it("search 中的下划线被转义为字面量", async () => {
    await repo.create(conversationFixture({ id: "conv-5", title: "a_b 测试", createdAt: "2026-07-22T00:04:00Z" }));
    const items = await repo.listConversationsWithMeta("user-1", { search: "a_b" });
    expect(items.map(i => i.id)).toEqual(["conv-5"]);
  });

  it("search 空白字符串退化为不过滤", async () => {
    const items = await repo.listConversationsWithMeta("user-1", { search: "   " });
    expect(items.length).toBe(3);
  });

  it("search 与 limit/offset 组合", async () => {
    await repo.create(conversationFixture({ id: "conv-6", title: "工作区二期", createdAt: "2026-07-22T00:05:00Z" }));
    const page1 = await repo.listConversationsWithMeta("user-1", { search: "工作区", limit: 1, offset: 0 });
    const page2 = await repo.listConversationsWithMeta("user-1", { search: "工作区", limit: 1, offset: 1 });
    expect(page1.length).toBe(1);
    expect(page2.length).toBe(1);
    expect(page1[0].id).not.toBe(page2[0].id);
  });
});

describe("SqliteConversationRepository - 助理对话排序与分页（F20260918imas）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("助理对话沉底：普通在前（含置顶优先），助理在最后", async () => {
    await repo.create(conversationFixture({ id: "conv-a", title: "微信助理 · x1", pinned: false }));
    await repo.create(conversationFixture({ id: "conv-n1", title: "普通对话", pinned: false }));
    await repo.create(conversationFixture({ id: "conv-n2", title: "置顶对话", pinned: true }));
    await repo.create(conversationFixture({ id: "conv-b", title: "飞书助理 · y2", pinned: true }));

    const items = await repo.listConversationsWithMeta("user-1");
    // 普通组内 pinned 优先；助理组内同样 pinned 优先（组内排序语义一致）
    expect(items.map(i => i.id)).toEqual(["conv-n2", "conv-n1", "conv-b", "conv-a"]);
  });

  it("分页跨页边界：limit 切在助理/普通交界不丢不重", async () => {
    await repo.create(conversationFixture({ id: "conv-n1", title: "普通一", createdAt: "2026-07-22T00:01:00Z" }));
    await repo.create(conversationFixture({ id: "conv-n2", title: "普通二", createdAt: "2026-07-22T00:02:00Z" }));
    await repo.create(conversationFixture({ id: "conv-a", title: "微信助理 · x1", createdAt: "2026-07-22T00:03:00Z" }));

    const page1 = await repo.listConversationsWithMeta("user-1", { limit: 2, offset: 0 });
    const page2 = await repo.listConversationsWithMeta("user-1", { limit: 2, offset: 2 });
    expect(page1.map(i => i.id)).toEqual(["conv-n2", "conv-n1"]);
    expect(page2.map(i => i.id)).toEqual(["conv-a"]);
  });
});
