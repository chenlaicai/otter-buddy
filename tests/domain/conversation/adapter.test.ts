import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationAdapter } from "@domain/conversation/_internal/adapter";
import type { ConversationRepository } from "@domain/conversation/_internal/repository";
import type {
  Conversation,
  KeyFact,
  LinkedResource,
  Message,
  MessageEvent,
} from "@domain/conversation/model";

// ===== Factory helpers =====

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "Test",
    status: "active",
    parentId: null,
    treePath: "/conv-1/",
    summary: null,
    createdAt: "2026-01-01 00:00:00",
    updatedAt: "2026-01-01 00:00:00",
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    senderType: "user",
    senderId: "user-1",
    status: "completed",
    body: "hello",
    attachments: null,
    sequenceNum: 1,
    createdAt: "2026-01-01 00:00:00",
    completedAt: null,
    ...overrides,
  };
}

function makeStreamingMessage(overrides: Partial<Message> = {}): Message {
  return makeMessage({
    senderType: "otter",
    senderId: "otter-1",
    status: "streaming",
    body: null,
    completedAt: null,
    ...overrides,
  });
}

function makeMessageEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    id: "evt-1",
    messageId: "msg-1",
    eventType: "text_delta",
    payload: { text: "delta" },
    sequenceNum: 1,
    createdAt: "2026-01-01 00:00:00",
    ...overrides,
  };
}

function makeKeyFact(overrides: Partial<KeyFact> = {}): KeyFact {
  return {
    id: "kf-1",
    conversationId: "conv-1",
    content: "important fact",
    category: null,
    userFlagged: false,
    createdBy: "user",
    otterId: null,
    createdAt: "2026-01-01 00:00:00",
    ...overrides,
  };
}

function makeLinkedResource(
  overrides: Partial<LinkedResource> = {},
): LinkedResource {
  return {
    id: "lr-1",
    conversationId: "conv-1",
    resourceType: "pr",
    url: "https://github.com/repo/pull/1",
    title: null,
    metadata: null,
    linkedBy: "user",
    otterId: null,
    autoLinked: false,
    createdAt: "2026-01-01 00:00:00",
    ...overrides,
  };
}

/** Create a mock ConversationRepository with all methods as vi.fn() */
function createMockRepo(): ConversationRepository {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    updateStatus: vi.fn(),
    getChildren: vi.fn(),
    getByTreePathPrefix: vi.fn(),
    createCompletedMessage: vi.fn(),
    createStreamingMessage: vi.fn(),
    completeMessage: vi.fn(),
    failMessage: vi.fn(),
    getMessageById: vi.fn(),
    getMessages: vi.fn(),
    getMaxSequenceNum: vi.fn(),
    appendEvent: vi.fn(),
    getMessageEvents: vi.fn(),
    getMaxEventSequenceNum: vi.fn(),
    getMessagesBefore: vi.fn(),
    getMessagesAfter: vi.fn(),
    addKeyFact: vi.fn(),
    linkResource: vi.fn(),
    getKeyFacts: vi.fn(),
    getLinkedResources: vi.fn(),
    getOtterIds: vi.fn(),
    createChild: vi.fn(),
  } as unknown as ConversationRepository;
}

let repo: ConversationRepository;
let port: ConversationAdapter;

beforeEach(() => {
  repo = createMockRepo();
  port = new ConversationAdapter(repo);
});

describe("ConversationAdapter - create", () => {
  it("root 对话 treePath = /${id}/", async () => {
    const created: Record<string, Conversation> = {};
    vi.mocked(repo.create).mockImplementation((id, params) => {
      created[id] = makeConversation({ id, ...params });
    });
    vi.mocked(repo.getById).mockImplementation((id) => created[id] ?? null);

    const conv = await port.create({ title: "Root", otterIds: [] });

    expect(conv.id).toMatch(/^[0-9a-f]{8}-/);
    expect(conv.treePath).toBe(`/${conv.id}/`);
    expect(conv.status).toBe("active");
    expect(conv.parentId).toBeNull();
  });

  it("child 对话 treePath = ${parent.treePath}${id}/", async () => {
    const parent = makeConversation({
      id: "parent-id",
      treePath: "/parent-id/",
    });
    const created: Record<string, Conversation> = {};
    vi.mocked(repo.getById).mockImplementation((id) => {
      if (id === "parent-id") return parent;
      return created[id] ?? null;
    });
    vi.mocked(repo.create).mockImplementation((id, params) => {
      created[id] = makeConversation({ id, ...params });
    });

    const conv = await port.create({
      title: "Child",
      parentId: "parent-id",
      otterIds: [],
    });

    expect(conv.treePath).toBe(`/parent-id/${conv.id}/`);
    expect(conv.parentId).toBe("parent-id");
  });

  it("create 生成有效 UUID", async () => {
    const created: Record<string, Conversation> = {};
    vi.mocked(repo.create).mockImplementation((id, params) => {
      created[id] = makeConversation({ id, ...params });
    });
    vi.mocked(repo.getById).mockImplementation((id) => created[id] ?? null);

    const conv = await port.create({ title: "Test", otterIds: [] });
    expect(conv.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("父不存在时 throw", async () => {
    vi.mocked(repo.getById).mockReturnValue(null);

    await expect(
      port.create({ title: "Child", parentId: "nonexistent", otterIds: [] }),
    ).rejects.toThrow(/Parent conversation .* not found/);
  });
});

describe("ConversationAdapter - createChild", () => {
  it("createChild 返回子对话", async () => {
    const childConv = makeConversation({
      id: "child-uuid",
      parentId: "root",
      treePath: "/root/child-uuid/",
    });
    vi.mocked(repo.createChild).mockReturnValue(childConv);

    const result = await port.createChild("root", "Child");

    expect(result.id).toBe("child-uuid");
    expect(result.parentId).toBe("root");
    expect(result.treePath).toBe("/root/child-uuid/");
  });

  it("父不存在时 throw", async () => {
    vi.mocked(repo.createChild).mockImplementation(() => {
      throw new Error("Parent conversation nonexistent not found");
    });

    await expect(port.createChild("nonexistent", "Child")).rejects.toThrow(
      /Parent conversation .* not found/,
    );
  });
});

describe("ConversationAdapter - complete + archive", () => {
  it("complete 正常: active -> completed", async () => {
    const conv = makeConversation({ status: "active" });
    vi.mocked(repo.getById).mockReturnValue(conv);
    vi.mocked(repo.updateStatus).mockImplementation((id, status) => {
      if (id === conv.id) {
        conv.status = status;
        if (status === "completed") conv.completedAt = "2026-01-02 00:00:00";
      }
    });

    await port.complete("conv-1");

    expect(conv.status).toBe("completed");
    expect(conv.completedAt).not.toBeNull();
  });

  it("complete 对 completed 对话 throw", async () => {
    vi.mocked(repo.getById).mockReturnValue(
      makeConversation({ status: "completed" }),
    );

    await expect(port.complete("conv-1")).rejects.toThrow(/Cannot complete/);
  });

  it("complete 对 archived 对话 throw", async () => {
    vi.mocked(repo.getById).mockReturnValue(
      makeConversation({ status: "archived" }),
    );

    await expect(port.complete("conv-1")).rejects.toThrow(/Cannot complete/);
  });

  it("complete 不存在的对话 throw", async () => {
    vi.mocked(repo.getById).mockReturnValue(null);

    await expect(port.complete("nonexistent")).rejects.toThrow(/not found/);
  });

  it("archive 正常: completed -> archived", async () => {
    const conv = makeConversation({ status: "completed" });
    vi.mocked(repo.getById).mockReturnValue(conv);
    vi.mocked(repo.updateStatus).mockImplementation((id, status) => {
      if (id === conv.id) {
        conv.status = status;
        if (status === "archived") conv.archivedAt = "2026-01-03 00:00:00";
      }
    });

    await port.archive("conv-1");

    expect(conv.status).toBe("archived");
    expect(conv.archivedAt).not.toBeNull();
  });

  it("archive 对 active 对话 throw", async () => {
    vi.mocked(repo.getById).mockReturnValue(makeConversation({ status: "active" }));

    await expect(port.archive("conv-1")).rejects.toThrow(/Cannot archive/);
  });

  it("archive 对 archived 对话 throw", async () => {
    vi.mocked(repo.getById).mockReturnValue(
      makeConversation({ status: "archived" }),
    );

    await expect(port.archive("conv-1")).rejects.toThrow(/Cannot archive/);
  });

  it("archive 不存在的对话 throw", async () => {
    vi.mocked(repo.getById).mockReturnValue(null);

    await expect(port.archive("nonexistent")).rejects.toThrow(/not found/);
  });
});

describe("ConversationAdapter - getTree", () => {
  it("返回完整树结构，children 递归嵌套", async () => {
    const root = makeConversation({ id: "root", treePath: "/root/" });
    const child1 = makeConversation({
      id: "c1",
      parentId: "root",
      treePath: "/root/c1/",
    });
    const child2 = makeConversation({
      id: "c2",
      parentId: "root",
      treePath: "/root/c2/",
    });
    const grandchild = makeConversation({
      id: "gc1",
      parentId: "c1",
      treePath: "/root/c1/gc1/",
    });

    vi.mocked(repo.getById).mockReturnValue(root);
    vi.mocked(repo.getByTreePathPrefix).mockReturnValue([
      root,
      child1,
      child2,
      grandchild,
    ]);

    const tree = await port.getTree("root");

    expect(tree.conversation.id).toBe("root");
    expect(tree.children).toHaveLength(2);
    const c1 = tree.children.find((c) => c.conversation.id === "c1")!;
    const c2 = tree.children.find((c) => c.conversation.id === "c2")!;
    expect(c1.children).toHaveLength(1);
    expect(c1.children[0].conversation.id).toBe("gc1");
    expect(c2.children).toHaveLength(0);
  });

  it("root 不存在时 throw", async () => {
    vi.mocked(repo.getById).mockReturnValue(null);

    await expect(port.getTree("nonexistent")).rejects.toThrow(/not found/);
  });
});

describe("ConversationAdapter - sendMessage", () => {
  it("sequence_num = getMaxSequenceNum + 1", async () => {
    vi.mocked(repo.getMaxSequenceNum).mockReturnValue(4);
    vi.mocked(repo.createCompletedMessage).mockReturnValue(
      makeMessage({ sequenceNum: 5 }),
    );

    const msg = await port.sendMessage("conv-1", {
      senderType: "user",
      senderId: "user-1",
      body: "hello",
    });

    expect(msg.sequenceNum).toBe(5);
  });
});

describe("ConversationAdapter - startMessage", () => {
  it("sequence_num = getMaxSequenceNum + 1, senderType 固定为 otter", async () => {
    vi.mocked(repo.getMaxSequenceNum).mockReturnValue(2);
    vi.mocked(repo.createStreamingMessage).mockReturnValue(
      makeStreamingMessage({ sequenceNum: 3 }),
    );

    const msg = await port.startMessage("conv-1", { senderId: "otter-1" });

    expect(msg.sequenceNum).toBe(3);
    expect(msg.senderType).toBe("otter");
    expect(msg.status).toBe("streaming");
  });
});

describe("ConversationAdapter - appendEvent", () => {
  it("streaming 消息正常追加事件，sequence_num = getMaxEventSequenceNum + 1", async () => {
    vi.mocked(repo.getMessageById).mockReturnValue(
      makeStreamingMessage({ id: "msg-1" }),
    );
    vi.mocked(repo.getMaxEventSequenceNum).mockReturnValue(2);
    vi.mocked(repo.appendEvent).mockReturnValue(
      makeMessageEvent({ sequenceNum: 3 }),
    );

    const evt = await port.appendEvent("msg-1", {
      eventType: "text_delta",
      payload: { text: "hello" },
    });

    expect(evt.sequenceNum).toBe(3);
  });

  it("对非 streaming 消息 throw", async () => {
    vi.mocked(repo.getMessageById).mockReturnValue(
      makeMessage({ status: "completed" }),
    );

    await expect(
      port.appendEvent("msg-1", { eventType: "text_delta", payload: {} }),
    ).rejects.toThrow(/Cannot append event/);
  });

  it("消息不存在时 throw", async () => {
    vi.mocked(repo.getMessageById).mockReturnValue(null);

    await expect(
      port.appendEvent("nonexistent", { eventType: "text_delta", payload: {} }),
    ).rejects.toThrow(/not found/);
  });
});

describe("ConversationAdapter - completeMessage", () => {
  it("streaming -> completed, 正常调用 repository", async () => {
    const streaming = makeStreamingMessage({ id: "msg-1", attachments: null });
    vi.mocked(repo.getMessageById).mockReturnValue(streaming);
    vi.mocked(repo.completeMessage).mockReturnValue(
      makeMessage({ status: "completed", body: "final", id: "msg-1" }),
    );

    const msg = await port.completeMessage("msg-1", { body: "final" });

    expect(msg.status).toBe("completed");
    expect(msg.body).toBe("final");
  });

  it("不提供 attachments 时保留 startMessage 时的预置（架构师-2 #1）", async () => {
    const existingAttachments = [{ type: "file", url: "https://file.com/1.pdf" }];
    const streaming = makeStreamingMessage({
      id: "msg-1",
      attachments: existingAttachments,
    });
    vi.mocked(repo.getMessageById).mockReturnValue(streaming);
    /** mock 返回传入的 attachments，验证 adapter 正确传递了 existing attachments */
    vi.mocked(repo.completeMessage).mockImplementation((_id, _body, attachments) =>
      makeMessage({ status: "completed", body: "final", attachments }),
    );

    const msg = await port.completeMessage("msg-1", { body: "final" });

    expect(msg.attachments).toEqual(existingAttachments);
  });

  it("提供 attachments 时覆盖", async () => {
    const existingAttachments = [{ type: "file", url: "https://old.com/1.pdf" }];
    const newAttachments = [{ type: "image", url: "https://new.com/1.png" }];
    const streaming = makeStreamingMessage({
      id: "msg-1",
      attachments: existingAttachments,
    });
    vi.mocked(repo.getMessageById).mockReturnValue(streaming);
    /** mock 返回传入的 attachments，验证 adapter 正确传递了 new attachments */
    vi.mocked(repo.completeMessage).mockImplementation((_id, _body, attachments) =>
      makeMessage({ status: "completed", body: "final", attachments }),
    );

    const msg = await port.completeMessage("msg-1", { body: "final", attachments: newAttachments });

    expect(msg.attachments).toEqual(newAttachments);
  });

  it("对非 streaming 消息 throw", async () => {
    vi.mocked(repo.getMessageById).mockReturnValue(
      makeMessage({ status: "completed" }),
    );

    await expect(
      port.completeMessage("msg-1", { body: "final" }),
    ).rejects.toThrow(/Cannot complete/);
  });

  it("消息不存在时 throw", async () => {
    vi.mocked(repo.getMessageById).mockReturnValue(null);

    await expect(
      port.completeMessage("nonexistent", { body: "final" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("ConversationAdapter - failMessage", () => {
  it("streaming -> failed, 正常调用 repository", async () => {
    vi.mocked(repo.getMessageById).mockReturnValue(
      makeStreamingMessage({ id: "msg-1" }),
    );
    vi.mocked(repo.failMessage).mockReturnValue(
      makeMessage({ status: "failed", body: null, id: "msg-1", completedAt: "2026-01-02" }),
    );

    const msg = await port.failMessage("msg-1");

    expect(msg.status).toBe("failed");
    expect(msg.body).toBeNull();
    expect(msg.completedAt).not.toBeNull();
  });

  it("对非 streaming 消息 throw", async () => {
    vi.mocked(repo.getMessageById).mockReturnValue(
      makeMessage({ status: "completed" }),
    );

    await expect(port.failMessage("msg-1")).rejects.toThrow(/Cannot fail/);
  });

  it("消息不存在时 throw", async () => {
    vi.mocked(repo.getMessageById).mockReturnValue(null);

    await expect(port.failMessage("nonexistent")).rejects.toThrow(/not found/);
  });
});

describe("ConversationAdapter - getMessageEvents", () => {
  it("返回 repository.getMessageEvents 结果", async () => {
    const events = [
      makeMessageEvent({ sequenceNum: 1 }),
      makeMessageEvent({ id: "evt-2", sequenceNum: 2 }),
    ];
    vi.mocked(repo.getMessageEvents).mockReturnValue(events);

    const result = await port.getMessageEvents("msg-1");
    expect(result).toBe(events);
  });
});

describe("ConversationAdapter - expandMessage", () => {
  it("both: 合并前后消息，按 sequence_num ASC 排序", async () => {
    const target = makeMessage({ id: "msg-5", sequenceNum: 5 });
    vi.mocked(repo.getMessageById).mockReturnValue(target);
    vi.mocked(repo.getMessagesBefore).mockReturnValue([
      makeMessage({ id: "msg-3", sequenceNum: 3 }),
      makeMessage({ id: "msg-4", sequenceNum: 4 }),
    ]);
    vi.mocked(repo.getMessagesAfter).mockReturnValue([
      makeMessage({ id: "msg-6", sequenceNum: 6 }),
      makeMessage({ id: "msg-7", sequenceNum: 7 }),
    ]);

    const result = await port.expandMessage("msg-5", "both", 2);

    expect(result.map((m) => m.sequenceNum)).toEqual([3, 4, 5, 6, 7]);
  });

  it("before: 返回指定消息之前的 N 条", async () => {
    const target = makeMessage({ id: "msg-5", sequenceNum: 5 });
    vi.mocked(repo.getMessageById).mockReturnValue(target);
    vi.mocked(repo.getMessagesBefore).mockReturnValue([
      makeMessage({ id: "msg-4", sequenceNum: 4 }),
      makeMessage({ id: "msg-3", sequenceNum: 3 }),
    ]);

    const result = await port.expandMessage("msg-5", "before", 2);
    expect(result.map((m) => m.sequenceNum)).toEqual([4, 3]);
  });

  it("after: 返回指定消息之后的 N 条", async () => {
    const target = makeMessage({ id: "msg-5", sequenceNum: 5 });
    vi.mocked(repo.getMessageById).mockReturnValue(target);
    vi.mocked(repo.getMessagesAfter).mockReturnValue([
      makeMessage({ id: "msg-6", sequenceNum: 6 }),
      makeMessage({ id: "msg-7", sequenceNum: 7 }),
    ]);

    const result = await port.expandMessage("msg-5", "after", 2);
    expect(result.map((m) => m.sequenceNum)).toEqual([6, 7]);
  });

  it("消息不存在时 throw", async () => {
    vi.mocked(repo.getMessageById).mockReturnValue(null);

    await expect(
      port.expandMessage("nonexistent", "before", 3),
    ).rejects.toThrow(/Message not found/);
  });
});

describe("ConversationAdapter - key info", () => {
  it("addKeyFact 返回 KeyFact", async () => {
    const fact = makeKeyFact();
    vi.mocked(repo.addKeyFact).mockReturnValue(fact);

    const result = await port.addKeyFact("conv-1", {
      content: "important fact",
      createdBy: "user",
    });

    expect(result.id).toBe("kf-1");
    expect(result.content).toBe("important fact");
    expect(result.conversationId).toBe("conv-1");
  });

  it("linkResource 返回 LinkedResource", async () => {
    const resource = makeLinkedResource();
    vi.mocked(repo.linkResource).mockReturnValue(resource);

    const result = await port.linkResource("conv-1", {
      resourceType: "pr",
      url: "https://github.com/repo/pull/1",
      linkedBy: "user",
    });

    expect(result.id).toBe("lr-1");
    expect(result.autoLinked).toBe(false);
  });

  it("getKeyInfo 返回 keyFacts + linkedResources 组合", async () => {
    const facts = [makeKeyFact()];
    const resources = [makeLinkedResource()];
    vi.mocked(repo.getKeyFacts).mockReturnValue(facts);
    vi.mocked(repo.getLinkedResources).mockReturnValue(resources);

    const info = await port.getKeyInfo("conv-1");

    expect(info.keyFacts).toBe(facts);
    expect(info.linkedResources).toBe(resources);
  });

  it("getLinkedResources 返回指定对话的链接资源列表", async () => {
    const resources = [makeLinkedResource()];
    vi.mocked(repo.getLinkedResources).mockReturnValue(resources);

    const result = await port.getLinkedResources("conv-1");
    expect(result).toBe(resources);
  });
});
