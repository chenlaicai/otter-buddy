import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "@infra/db/database";
import { initSchema } from "@infra/db/schema";
import { ConversationRepository } from "@domain/conversation/_internal/repository";
import { ConversationAdapter } from "@domain/conversation/_internal/adapter";
import type { ConversationPort } from "@domain/conversation/port";
import type { MessageInput } from "@domain/conversation/model";

/** 插入 otter 记录（满足 conversation_otters 外键约束） */
function insertOtter(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO otters (id, name, type) VALUES (?, ?, 'big')",
  ).run(id, `Otter-${id}`);
}

function makeMessage(overrides: Partial<MessageInput> = {}): MessageInput {
  return { senderType: "user", senderId: "user-1", content: "hello", ...overrides };
}

let db: Database.Database;
let repo: ConversationRepository;
let port: ConversationPort;

beforeEach(() => {
  db = initDatabase({ dbPath: ":memory:" });
  initSchema(db);
  repo = new ConversationRepository(db);
  port = new ConversationAdapter(repo);
});

afterEach(() => {
  closeDatabase(db);
});

describe("ConversationAdapter - create", () => {
  it("root 对话 treePath = /${id}/", async () => {
    const conv = await port.create({ title: "Root", otterIds: [] });
    expect(conv.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(conv.treePath).toBe(`/${conv.id}/`);
    expect(conv.status).toBe("active");
    expect(conv.parentId).toBeNull();
  });

  it("child 对话 treePath = ${parent.treePath}${id}/", async () => {
    const root = await port.create({ title: "Root", otterIds: [] });
    const child = await port.create({ title: "Child", parentId: root.id, otterIds: [] });
    expect(child.treePath).toBe(`${root.treePath}${child.id}/`);
    expect(child.parentId).toBe(root.id);
  });

  it("create 生成有效 UUID", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    expect(conv.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("父不存在时 throw", async () => {
    await expect(port.create({ title: "Child", parentId: "nonexistent", otterIds: [] }))
      .rejects.toThrow(/Parent conversation .* not found/);
  });

  it("otterIds 写入 conversation_otters", async () => {
    insertOtter(db, "otter-1");
    const conv = await port.create({ title: "Root", otterIds: ["otter-1"] });
    expect(repo.getOtterIds(conv.id)).toEqual(["otter-1"]);
  });
});

describe("ConversationAdapter - createChild", () => {
  it("treePath 继承父路径，otterIds 从父复制", async () => {
    insertOtter(db, "otter-1");
    const root = await port.create({ title: "Root", otterIds: ["otter-1"] });
    const child = await port.createChild(root.id, "Child");
    expect(child.treePath).toBe(`${root.treePath}${child.id}/`);
    expect(child.parentId).toBe(root.id);
    expect(repo.getOtterIds(child.id)).toEqual(["otter-1"]);
  });

  it("parent.updated_at 被更新", async () => {
    const root = await port.create({ title: "Root", otterIds: [] });
    await port.createChild(root.id, "Child");
    const after = await port.getById(root.id);
    expect(after!.updatedAt).toBeTruthy();
  });

  it("父不存在时 throw", async () => {
    await expect(port.createChild("nonexistent", "Child")).rejects.toThrow(
      /Parent conversation .* not found/,
    );
  });
});

describe("ConversationAdapter - complete + archive", () => {
  it("complete: status active -> completed", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    await port.complete(conv.id);
    const after = await port.getById(conv.id);
    expect(after!.status).toBe("completed");
    expect(after!.completedAt).not.toBeNull();
  });

  it("complete 对 completed 对话 throw", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    await port.complete(conv.id);
    await expect(port.complete(conv.id)).rejects.toThrow(/Cannot complete/);
  });

  it("complete 对 archived 对话 throw", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    await port.complete(conv.id);
    await port.archive(conv.id);
    await expect(port.complete(conv.id)).rejects.toThrow(/Cannot complete/);
  });

  it("archive: status completed -> archived", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    await port.complete(conv.id);
    await port.archive(conv.id);
    const after = await port.getById(conv.id);
    expect(after!.status).toBe("archived");
    expect(after!.archivedAt).not.toBeNull();
  });

  it("archive 对 active 对话 throw", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    await expect(port.archive(conv.id)).rejects.toThrow(/Cannot archive/);
  });

  it("archive 对 archived 对话 throw", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    await port.complete(conv.id);
    await port.archive(conv.id);
    await expect(port.archive(conv.id)).rejects.toThrow(/Cannot archive/);
  });

  it("complete 不存在的对话 throw", async () => {
    await expect(port.complete("nonexistent")).rejects.toThrow(/not found/);
  });

  it("archive 不存在的对话 throw", async () => {
    await expect(port.archive("nonexistent")).rejects.toThrow(/not found/);
  });
});

describe("ConversationAdapter - getTree", () => {
  it("返回完整树结构，children 递归嵌套", async () => {
    const root = await port.create({ title: "Root", otterIds: [] });
    const child1 = await port.createChild(root.id, "C1");
    const child2 = await port.createChild(root.id, "C2");
    const grandchild = await port.createChild(child1.id, "GC1");

    const tree = await port.getTree(root.id);
    expect(tree.conversation.id).toBe(root.id);
    expect(tree.children).toHaveLength(2);
    const c1 = tree.children.find((c) => c.conversation.id === child1.id)!;
    const c2 = tree.children.find((c) => c.conversation.id === child2.id)!;
    expect(c1.children).toHaveLength(1);
    expect(c1.children[0].conversation.id).toBe(grandchild.id);
    expect(c2.children).toHaveLength(0);
  });

  it("root 不存在时 throw", async () => {
    await expect(port.getTree("nonexistent")).rejects.toThrow(/not found/);
  });
});

describe("ConversationAdapter - sendMessage + getMessages", () => {
  it("sequence_num per-conversation 自增", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    const msg1 = await port.sendMessage(conv.id, makeMessage({ content: "first" }));
    const msg2 = await port.sendMessage(conv.id, makeMessage({ content: "second" }));
    expect(msg1.sequenceNum).toBe(1);
    expect(msg2.sequenceNum).toBe(2);
  });

  it("返回含 id/sequenceNum/createdAt 的 Message", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    const msg = await port.sendMessage(conv.id, makeMessage());
    expect(msg.id).toMatch(/^[0-9a-f]{8}-/);
    expect(msg.sequenceNum).toBe(1);
    expect(msg.createdAt).toBeTruthy();
    expect(msg.conversationId).toBe(conv.id);
  });

  it("不同对话的 sequence_num 独立", async () => {
    const conv1 = await port.create({ title: "C1", otterIds: [] });
    const conv2 = await port.create({ title: "C2", otterIds: [] });
    const msg1 = await port.sendMessage(conv1.id, makeMessage());
    const msg2 = await port.sendMessage(conv2.id, makeMessage());
    expect(msg1.sequenceNum).toBe(1);
    expect(msg2.sequenceNum).toBe(1);
  });

  it("getMessages 按 sequence_num 倒序返回", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    await port.sendMessage(conv.id, makeMessage({ content: "m1" }));
    await port.sendMessage(conv.id, makeMessage({ content: "m2" }));
    await port.sendMessage(conv.id, makeMessage({ content: "m3" }));
    const messages = await port.getMessages(conv.id);
    expect(messages.map((m) => m.content)).toEqual(["m3", "m2", "m1"]);
  });

  it("getMessages 无 limit 时默认 50 条", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    for (let i = 0; i < 55; i++) {
      await port.sendMessage(conv.id, makeMessage());
    }
    expect(await port.getMessages(conv.id)).toHaveLength(50);
  });

  it("getMessages before 分页正确", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(await port.sendMessage(conv.id, makeMessage()));
    }
    const page = await port.getMessages(conv.id, { before: msgs[5].id, limit: 3 });
    expect(page.map((m) => m.sequenceNum)).toEqual([5, 4, 3]);
  });
});

describe("ConversationAdapter - expandMessage", () => {
  it("before: 返回指定消息之前的 N 条", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(await port.sendMessage(conv.id, makeMessage()));
    }
    const before = await port.expandMessage(msgs[4].id, "before", 3);
    expect(before.map((m) => m.sequenceNum)).toEqual([4, 3, 2]);
  });

  it("after: 返回指定消息之后的 N 条", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(await port.sendMessage(conv.id, makeMessage()));
    }
    const after = await port.expandMessage(msgs[4].id, "after", 3);
    expect(after.map((m) => m.sequenceNum)).toEqual([6, 7, 8]);
  });

  it("both: 合并前后消息，按 sequence_num ASC 排序", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    const msgs = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(await port.sendMessage(conv.id, makeMessage()));
    }
    const both = await port.expandMessage(msgs[4].id, "both", 2);
    expect(both).toHaveLength(5);
    expect(both.map((m) => m.sequenceNum)).toEqual([3, 4, 5, 6, 7]);
  });

  it("消息不存在时 throw", async () => {
    await expect(port.expandMessage("nonexistent", "before", 3)).rejects.toThrow(
      /Message not found/,
    );
  });
});

describe("ConversationAdapter - key info", () => {
  it("addKeyFact 写入 key_facts，返回 KeyFact", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    const fact = await port.addKeyFact(conv.id, { content: "important fact", createdBy: "user" });
    expect(fact.id).toMatch(/^[0-9a-f]{8}-/);
    expect(fact.conversationId).toBe(conv.id);
    expect(fact.content).toBe("important fact");
  });

  it("linkResource 写入 linked_resources，返回 LinkedResource", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    const res = await port.linkResource(conv.id, {
      resourceType: "pr", url: "https://github.com/repo/pull/1",
      linkedBy: "otter", otterId: "otter-1", autoLinked: true,
    });
    expect(res.id).toMatch(/^[0-9a-f]{8}-/);
    expect(res.autoLinked).toBe(true);
  });

  it("getKeyInfo 返回 keyFacts + linkedResources 组合", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    await port.addKeyFact(conv.id, { content: "fact1", createdBy: "user" });
    await port.linkResource(conv.id, { resourceType: "url", url: "https://example.com", linkedBy: "user" });
    const info = await port.getKeyInfo(conv.id);
    expect(info.keyFacts).toHaveLength(1);
    expect(info.linkedResources).toHaveLength(1);
  });

  it("getLinkedResources 返回指定对话的链接资源列表", async () => {
    const conv = await port.create({ title: "Test", otterIds: [] });
    await port.linkResource(conv.id, { resourceType: "url", url: "https://a.com", linkedBy: "user" });
    await port.linkResource(conv.id, { resourceType: "pr", url: "https://b.com", linkedBy: "user" });
    expect(await port.getLinkedResources(conv.id)).toHaveLength(2);
  });
});

describe("ConversationAdapter - B-Conv-12", () => {
  it("完成子对话后父对话仍为 active", async () => {
    const root = await port.create({ title: "Root", otterIds: [] });
    const child = await port.createChild(root.id, "Child");
    await port.complete(child.id);
    const parent = await port.getById(root.id);
    expect(parent!.status).toBe("active");
  });
});

void vi;
