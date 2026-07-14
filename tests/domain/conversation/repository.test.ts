import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase, closeDatabase } from "@infra/db/database";
import { initSchema } from "@infra/db/schema";
import { ConversationRepository } from "@domain/conversation/_internal/repository";
import type {
  KeyFactInput,
  LinkedResourceInput,
  MessageEventInput,
  MessageInput,
  StartMessageInput,
} from "@domain/conversation/model";

/** 插入 otter 记录（满足 conversation_otters 外键约束） */
function insertOtter(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO otters (id, name, type) VALUES (?, ?, 'big')",
  ).run(id, `Otter-${id}`);
}

/** 插入对话记录（满足 messages 等外键约束） */
function insertConversation(db: Database.Database, id: string, treePath: string): void {
  db.prepare(
    "INSERT INTO conversations (id, title, tree_path) VALUES (?, ?, ?)",
  ).run(id, "Test", treePath);
}

function makeMessage(overrides: Partial<MessageInput> = {}): MessageInput {
  return { senderType: "user", senderId: "user-1", body: "hello", ...overrides };
}

function makeStartMessage(overrides: Partial<StartMessageInput> = {}): StartMessageInput {
  return { senderId: "otter-1", ...overrides };
}

function makeEvent(overrides: Partial<MessageEventInput> = {}): MessageEventInput {
  return { eventType: "text_delta", payload: { text: "delta" }, ...overrides };
}

function makeKeyFact(overrides: Partial<KeyFactInput> = {}): KeyFactInput {
  return { content: "important fact", createdBy: "user", ...overrides };
}

function makeLinkedResource(overrides: Partial<LinkedResourceInput> = {}): LinkedResourceInput {
  return { resourceType: "pr", url: "https://github.com/repo/pull/1", linkedBy: "user", ...overrides };
}

let db: Database.Database;
let repo: ConversationRepository;

beforeEach(() => {
  db = initDatabase({ dbPath: ":memory:" });
  initSchema(db);
  repo = new ConversationRepository(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe("ConversationRepository - create + getById", () => {
  it("创建 root 对话，treePath=/${id}/", () => {
    repo.create("conv-1", {
      title: "Root", parentId: null, treePath: "/conv-1/", otterIds: [],
    });
    const conv = repo.getById("conv-1")!;
    expect(conv.id).toBe("conv-1");
    expect(conv.title).toBe("Root");
    expect(conv.status).toBe("active");
    expect(conv.parentId).toBeNull();
    expect(conv.treePath).toBe("/conv-1/");
    expect(conv.createdAt).toBeTruthy();
    expect(conv.completedAt).toBeNull();
  });

  it("getById 未找到返回 null", () => {
    expect(repo.getById("nonexistent")).toBeNull();
  });

  it("create 含 otterIds 写入 conversation_otters", () => {
    insertOtter(db, "otter-1");
    insertOtter(db, "otter-2");
    repo.create("conv-1", {
      title: "Root", parentId: null, treePath: "/conv-1/", otterIds: ["otter-1", "otter-2"],
    });
    expect(repo.getOtterIds("conv-1")).toEqual(["otter-1", "otter-2"]);
  });
});

describe("ConversationRepository - complete + archive", () => {
  it("updateStatus completed: status -> completed, completed_at 非空, updated_at 更新", () => {
    repo.create("conv-1", { title: "Test", parentId: null, treePath: "/conv-1/", otterIds: [] });
    repo.updateStatus("conv-1", "completed");
    const after = repo.getById("conv-1")!;
    expect(after.status).toBe("completed");
    expect(after.completedAt).not.toBeNull();
    expect(after.updatedAt).toBeTruthy();
  });

  it("updateStatus archived: status -> archived, archived_at 非空, updated_at 更新", () => {
    repo.create("conv-1", { title: "Test", parentId: null, treePath: "/conv-1/", otterIds: [] });
    repo.updateStatus("conv-1", "completed");
    repo.updateStatus("conv-1", "archived");
    const after = repo.getById("conv-1")!;
    expect(after.status).toBe("archived");
    expect(after.archivedAt).not.toBeNull();
    expect(after.updatedAt).toBeTruthy();
  });
});

describe("ConversationRepository - createChild", () => {
  it("treePath 继承父路径，otterIds 从父复制，parent.updated_at 更新", () => {
    insertOtter(db, "otter-1");
    repo.create("root", { title: "Root", parentId: null, treePath: "/root/", otterIds: ["otter-1"] });
    const child = repo.createChild("root", "child-1", "Child");
    expect(child.treePath).toBe("/root/child-1/");
    expect(child.parentId).toBe("root");
    expect(child.status).toBe("active");
    expect(repo.getOtterIds("child-1")).toEqual(["otter-1"]);
    const parentAfter = repo.getById("root")!;
    expect(parentAfter.updatedAt).toBeTruthy();
  });

  it("父不存在时 throw Error", () => {
    expect(() => repo.createChild("nonexistent", "child-1", "Child")).toThrow(
      /Parent conversation .* not found/,
    );
  });

  it("事务原子性：INSERT child 失败时 parent.updated_at 不更新", () => {
    repo.create("root", { title: "Root", parentId: null, treePath: "/root/", otterIds: [] });
    repo.createChild("root", "child-1", "First Child");

    // Set root's updated_at to a known old value
    db.prepare("UPDATE conversations SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run("root");

    // Attempt createChild with duplicate childId (PK violation) -- should fail and rollback
    expect(() => repo.createChild("root", "child-1", "Duplicate")).toThrow();

    // Verify parent.updated_at was NOT updated (transaction rolled back)
    const after = repo.getById("root")!;
    expect(after.updatedAt).toBe("2020-01-01 00:00:00");
  });
});

describe("ConversationRepository - tree queries", () => {
  it("getChildren 返回直接子对话", () => {
    repo.create("root", { title: "Root", parentId: null, treePath: "/root/", otterIds: [] });
    repo.createChild("root", "child-1", "C1");
    repo.createChild("root", "child-2", "C2");
    repo.createChild("child-1", "grandchild-1", "GC1");
    const children = repo.getChildren("root");
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.id).sort()).toEqual(["child-1", "child-2"]);
  });

  it("getByTreePathPrefix 返回所有匹配的对话", () => {
    repo.create("root", { title: "Root", parentId: null, treePath: "/root/", otterIds: [] });
    repo.createChild("root", "child-1", "C1");
    repo.createChild("child-1", "grandchild-1", "GC1");
    const nodes = repo.getByTreePathPrefix("/root/%");
    expect(nodes).toHaveLength(3);
  });
});

describe("ConversationRepository - createCompletedMessage (sendMessage)", () => {
  it("创建 status='completed', body 非空, completed_at=NULL 的消息", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const msg = repo.createCompletedMessage("msg-1", "conv-1", makeMessage({ body: "hello" }), 1);
    expect(msg.status).toBe("completed");
    expect(msg.body).toBe("hello");
    expect(msg.completedAt).toBeNull();
    expect(msg.sequenceNum).toBe(1);
  });

  it("sequence_num 自增", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const msg1 = repo.createCompletedMessage("msg-1", "conv-1", makeMessage({ body: "first" }), 1);
    const msg2 = repo.createCompletedMessage("msg-2", "conv-1", makeMessage({ body: "second" }), 2);
    expect(msg1.sequenceNum).toBe(1);
    expect(msg2.sequenceNum).toBe(2);
  });

  it("attachments JSON 序列化/反序列化", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const attachments = [{ type: "image", url: "https://img.com/1.png", name: "pic" }];
    const msg = repo.createCompletedMessage("msg-1", "conv-1", makeMessage({ attachments }), 1);
    expect(msg.attachments).toEqual(attachments);
  });

  it("返回值 createdAt 从 DB 读取", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const msg = repo.createCompletedMessage("msg-1", "conv-1", makeMessage(), 1);
    expect(msg.id).toBe("msg-1");
    expect(msg.createdAt).toBeTruthy();
  });
});

describe("ConversationRepository - createStreamingMessage (startMessage)", () => {
  it("创建 status='streaming', body=NULL 的消息", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const msg = repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    expect(msg.status).toBe("streaming");
    expect(msg.body).toBeNull();
    expect(msg.senderType).toBe("otter");
    expect(msg.completedAt).toBeNull();
  });

  it("带 attachments 时正确写入", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const attachments = [{ type: "file", url: "https://file.com/1.pdf" }];
    const msg = repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage({ attachments }), 1);
    expect(msg.attachments).toEqual(attachments);
  });
});

describe("ConversationRepository - completeMessage", () => {
  it("streaming -> completed, body 设置, completed_at 非空", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    const msg = repo.completeMessage("msg-1", "final body", null);
    expect(msg.status).toBe("completed");
    expect(msg.body).toBe("final body");
    expect(msg.completedAt).not.toBeNull();
  });

  it("设置 attachments", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    const attachments = [{ type: "image", url: "https://img.com/1.png" }];
    const msg = repo.completeMessage("msg-1", "final body", attachments);
    expect(msg.attachments).toEqual(attachments);
  });

  it("对非 streaming 消息 throw（UPDATE 0 rows）", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createCompletedMessage("msg-1", "conv-1", makeMessage(), 1);
    expect(() => repo.completeMessage("msg-1", "body", null)).toThrow(
      /not found or not in streaming status/,
    );
  });

  it("不存在的消息 throw", () => {
    expect(() => repo.completeMessage("nonexistent", "body", null)).toThrow(
      /not found or not in streaming status/,
    );
  });
});

describe("ConversationRepository - failMessage", () => {
  it("streaming -> failed, body=NULL, completed_at 非空", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    const msg = repo.failMessage("msg-1");
    expect(msg.status).toBe("failed");
    expect(msg.body).toBeNull();
    expect(msg.completedAt).not.toBeNull();
  });

  it("对非 streaming 消息 throw（UPDATE 0 rows）", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createCompletedMessage("msg-1", "conv-1", makeMessage(), 1);
    expect(() => repo.failMessage("msg-1")).toThrow(
      /not found or not in streaming status/,
    );
  });
});

describe("ConversationRepository - appendEvent + getMessageEvents", () => {
  it("事件写入 message_events，sequence_num per-message 自增", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    const e1 = repo.appendEvent("evt-1", "msg-1", makeEvent(), 1);
    const e2 = repo.appendEvent("evt-2", "msg-1", makeEvent({ payload: { text: "second" } }), 2);
    expect(e1.sequenceNum).toBe(1);
    expect(e2.sequenceNum).toBe(2);
  });

  it("getMessageEvents 按 sequence_num ASC 返回", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    repo.appendEvent("evt-3", "msg-1", makeEvent({ payload: { text: "third" } }), 3);
    repo.appendEvent("evt-1", "msg-1", makeEvent({ payload: { text: "first" } }), 1);
    repo.appendEvent("evt-2", "msg-1", makeEvent({ payload: { text: "second" } }), 2);
    const events = repo.getMessageEvents("msg-1");
    expect(events.map((e) => e.sequenceNum)).toEqual([1, 2, 3]);
  });

  it("getMessageEvents 空列表返回空数组", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    expect(repo.getMessageEvents("msg-1")).toEqual([]);
  });

  it("payload JSON 序列化/反序列化正确", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    const payload = { toolName: "memory_search", args: { query: "test" } };
    const evt = repo.appendEvent("evt-1", "msg-1", makeEvent({ eventType: "tool_call", payload }), 1);
    expect(evt.payload).toEqual(payload);
  });

  it("getMaxEventSequenceNum 返回当前最大值", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    repo.appendEvent("evt-1", "msg-1", makeEvent(), 1);
    repo.appendEvent("evt-2", "msg-1", makeEvent(), 5);
    expect(repo.getMaxEventSequenceNum("msg-1")).toBe(5);
  });

  it("getMaxEventSequenceNum 无事件时返回 0", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    expect(repo.getMaxEventSequenceNum("msg-1")).toBe(0);
  });

  it("message_events 外键约束：message_id 不存在时 INSERT 抛出异常", () => {
    expect(() =>
      repo.appendEvent("evt-1", "nonexistent", makeEvent(), 1),
    ).toThrow();
  });
});

describe("ConversationRepository - getMessages with status filter", () => {
  it("status 过滤正确", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createCompletedMessage("msg-1", "conv-1", makeMessage(), 1);
    repo.createStreamingMessage("msg-2", "conv-1", makeStartMessage(), 2);
    repo.createCompletedMessage("msg-3", "conv-1", makeMessage(), 3);

    const completed = repo.getMessages("conv-1", { status: "completed" });
    expect(completed).toHaveLength(2);
    expect(completed.every((m) => m.status === "completed")).toBe(true);

    const streaming = repo.getMessages("conv-1", { status: "streaming" });
    expect(streaming).toHaveLength(1);
    expect(streaming[0].id).toBe("msg-2");
  });

  it("默认返回所有状态", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createCompletedMessage("msg-1", "conv-1", makeMessage(), 1);
    repo.createStreamingMessage("msg-2", "conv-1", makeStartMessage(), 2);
    expect(repo.getMessages("conv-1")).toHaveLength(2);
  });
});

describe("ConversationRepository - getMessages pagination", () => {
  it("默认 limit=50", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    for (let i = 1; i <= 60; i++) {
      repo.createCompletedMessage(`msg-${i}`, "conv-1", makeMessage(), i);
    }
    expect(repo.getMessages("conv-1")).toHaveLength(50);
  });

  it("before 分页正确", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    for (let i = 1; i <= 10; i++) {
      repo.createCompletedMessage(`msg-${i}`, "conv-1", makeMessage(), i);
    }
    const messages = repo.getMessages("conv-1", { before: "msg-7", limit: 3 });
    expect(messages.map((m) => m.sequenceNum)).toEqual([6, 5, 4]);
  });

  it("getMaxSequenceNum 返回当前最大值", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    repo.createCompletedMessage("msg-1", "conv-1", makeMessage(), 1);
    repo.createCompletedMessage("msg-2", "conv-1", makeMessage(), 5);
    expect(repo.getMaxSequenceNum("conv-1")).toBe(5);
  });

  it("getMaxSequenceNum 无消息时返回 0", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    expect(repo.getMaxSequenceNum("conv-1")).toBe(0);
  });
});

describe("ConversationRepository - expandMessage", () => {
  it("before: 返回指定消息之前的 N 条（倒序）", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    for (let i = 1; i <= 10; i++) {
      repo.createCompletedMessage(`msg-${i}`, "conv-1", makeMessage(), i);
    }
    const before = repo.getMessagesBefore("conv-1", "msg-5", 3);
    expect(before.map((m) => m.sequenceNum)).toEqual([4, 3, 2]);
  });

  it("after: 返回指定消息之后的 N 条（正序）", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    for (let i = 1; i <= 10; i++) {
      repo.createCompletedMessage(`msg-${i}`, "conv-1", makeMessage(), i);
    }
    const after = repo.getMessagesAfter("conv-1", "msg-5", 3);
    expect(after.map((m) => m.sequenceNum)).toEqual([6, 7, 8]);
  });
});

describe("ConversationRepository - key info + JSON", () => {
  it("addKeyFact + getKeyFacts", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const fact = repo.addKeyFact("kf-1", "conv-1", makeKeyFact({ content: "key fact" }));
    expect(fact.content).toBe("key fact");
    expect(fact.userFlagged).toBe(false);
    expect(repo.getKeyFacts("conv-1")).toHaveLength(1);
  });

  it("linkResource + getLinkedResources", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const res = repo.linkResource("lr-1", "conv-1", makeLinkedResource({ url: "https://example.com" }));
    expect(res.url).toBe("https://example.com");
    expect(res.autoLinked).toBe(false);
    expect(repo.getLinkedResources("conv-1")).toHaveLength(1);
  });

  it("metadata JSON 序列化/反序列化", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const metadata = { key: "value", num: 42 };
    const res = repo.linkResource("lr-1", "conv-1", makeLinkedResource({ metadata }));
    expect(res.metadata).toEqual(metadata);
  });

  it("auto_linked INTEGER 0/1 <-> boolean", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const res = repo.linkResource("lr-1", "conv-1", makeLinkedResource());
    expect(res.autoLinked).toBe(false);
    const raw = db.prepare("SELECT auto_linked FROM linked_resources WHERE id = ?").get("lr-1") as { auto_linked: number };
    expect(raw.auto_linked).toBe(0);

    db.prepare(
      `INSERT INTO linked_resources (id, conversation_id, resource_type, url, linked_by, auto_linked)
       VALUES (?, ?, 'url', 'https://auto.com', 'otter', 1)`,
    ).run("lr-2", "conv-1");
    const auto = repo.getLinkedResources("conv-1").find((r) => r.id === "lr-2")!;
    expect(auto.autoLinked).toBe(true);
  });

  it("user_flagged INTEGER 0/1 <-> boolean", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    db.prepare(
      "INSERT INTO key_facts (id, conversation_id, content, created_by, user_flagged) VALUES (?, ?, ?, ?, 1)",
    ).run("kf-1", "conv-1", "flagged fact", "user");
    expect(repo.getKeyFacts("conv-1")[0].userFlagged).toBe(true);
  });
});

describe("ConversationRepository - 外键约束", () => {
  it("conversation_id 不存在时 INSERT message 抛出异常", () => {
    expect(() =>
      repo.createCompletedMessage("msg-1", "nonexistent", makeMessage(), 1),
    ).toThrow();
  });
});

describe("ConversationRepository - body/status/completed_at 映射", () => {
  it("body NULL 映射正确（DB NULL -> null）", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const msg = repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    expect(msg.body).toBeNull();
  });

  it("status 映射正确（TEXT -> union type）", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const streaming = repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    expect(streaming.status).toBe("streaming");
    const completed = repo.completeMessage("msg-1", "body", null);
    expect(completed.status).toBe("completed");
  });

  it("completed_at 映射正确（NULL -> null, 非NULL -> string）", () => {
    insertConversation(db, "conv-1", "/conv-1/");
    const streaming = repo.createStreamingMessage("msg-1", "conv-1", makeStartMessage(), 1);
    expect(streaming.completedAt).toBeNull();
    const completed = repo.completeMessage("msg-1", "body", null);
    expect(completed.completedAt).not.toBeNull();
    expect(typeof completed.completedAt).toBe("string");
  });
});
