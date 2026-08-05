import { describe, it, expect, vi } from "vitest";

function mockLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => mockLogger() };
}
import { Hono } from "hono";
import { ConversationController } from "@interface-adapters/http/controllers/conversation-controller";
import { OtterController } from "@interface-adapters/http/controllers/otter-controller";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { SettingsController } from "@interface-adapters/http/controllers/settings-controller";
import { MemoryController } from "@interface-adapters/http/controllers/memory-controller";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ManageParticipant } from "@usecases/conversation/manage-participant";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { DissolveOtter } from "@usecases/otter/dissolve-otter";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { ManageReadState } from "@usecases/conversation/manage-read-state";
import type { SettingsRepository } from "@usecases/settings/settings-repository";
import type { Conversation } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import type { SearchMemory } from "@usecases/memory/search-memory";
import type { ManageMemory } from "@usecases/memory/manage-memory";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import { DomainError } from "@entities/errors";

function mockConversation(): Conversation {
  return {
    id: "conv-1", title: "Test", status: "active", summary: null, pinned: false,
    createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:00Z",
    completedAt: null, archivedAt: null,
  };
}

function mockOtter(): Otter {
  return {
    id: "otter-1", name: "Big Otter", type: "big", status: "active",
    role: null, parentOtterId: null,
    createdAt: "2026-07-16T00:00:00Z", dissolvedAt: null,
  };
}

describe("ConversationController", () => {
  function createApp(controller: ConversationController): Hono {
    const app = new Hono();
    app.get("/api/conversations/:id", (c) => controller.getById(c));
    app.post("/api/conversations", (c) => controller.create(c));
    app.patch("/api/conversations/:id/complete", (c) => controller.complete(c));
    app.patch("/api/conversations/:id/pin", (c) => controller.pin(c));
    app.patch("/api/conversations/:id/unpin", (c) => controller.unpin(c));
    return app;
  }

  it("returns 200 with DTO for existing conversation", async () => {
    const manageConv = { getById: async () => mockConversation() } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant, { get: vi.fn().mockResolvedValue(null) } as any, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/conv-1");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.id).toBe("conv-1");
    expect(json.title).toBe("Test");
  });

  it("returns 404 for non-existent conversation", async () => {
    const manageConv = { getById: async () => null } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant, { get: vi.fn().mockResolvedValue(null) } as any, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 201 on create", async () => {
    const manageConv = {
      create: async () => mockConversation(),
    } as unknown as ManageConversation;
    const managePart = {
      getActiveParticipants: async () => [{ participant: { otterId: "otter-1" }, otterName: "Big Otter" }],
    } as unknown as ManageParticipant;
    const ctrl = new ConversationController(manageConv, managePart, { get: vi.fn().mockResolvedValue(null) } as any, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.title).toBe("Test");
  });

  it("pin 成功返回 200 和 status=pinned", async () => {
    const manageConv = {
      pin: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant, { get: vi.fn().mockResolvedValue(null) } as any, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/conv-1/pin", { method: "PATCH" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("pinned");
  });

  it("pin 不存在返回 404", async () => {
    const manageConv = {
      pin: vi.fn().mockRejectedValue(new DomainError("Conversation not found", "not_found")),
    } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant, { get: vi.fn().mockResolvedValue(null) } as any, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/nonexistent/pin", { method: "PATCH" });
    expect(res.status).toBe(404);
  });

  it("unpin 成功返回 200 和 status=unpinned", async () => {
    const manageConv = {
      unpin: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant, { get: vi.fn().mockResolvedValue(null) } as any, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/conv-1/unpin", { method: "PATCH" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("unpinned");
  });

  it("unpin healing 对话被拒绝返回 403", async () => {
    const healingId = "healing-conv-id";
    const manageConv = {
      unpin: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant, { get: vi.fn().mockResolvedValue(healingId) } as any, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request(`/api/conversations/${healingId}/unpin`, { method: "PATCH" });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("系统对话不可取消置顶");
    expect(manageConv.unpin).not.toHaveBeenCalled();
  });

  it("unpin 不存在返回 404", async () => {
    const manageConv = {
      unpin: vi.fn().mockRejectedValue(new DomainError("Conversation not found", "not_found")),
    } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant, { get: vi.fn().mockResolvedValue(null) } as any, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/nonexistent/unpin", { method: "PATCH" });
    expect(res.status).toBe(404);
  });
});

describe("OtterController", () => {
  function createApp(controller: OtterController): Hono {
    const app = new Hono();
    app.get("/api/otters/:id", (c) => controller.getById(c));
    return app;
  }

  it("returns 200 with DTO for existing otter", async () => {
    const queryOtter = { getById: async () => mockOtter() } as unknown as QueryOtter;
    const ctrl = new OtterController({} as CreateOtter, {} as DissolveOtter, {} as ManageSession, queryOtter, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request("/api/otters/otter-1");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.name).toBe("Big Otter");
    expect(json.type).toBe("big");
  });

  it("returns 404 for non-existent otter", async () => {
    const queryOtter = { getById: async () => null } as unknown as QueryOtter;
    const ctrl = new OtterController({} as CreateOtter, {} as DissolveOtter, {} as ManageSession, queryOtter, mockLogger());
    const app = createApp(ctrl);
    const res = await app.request("/api/otters/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("MessageController", () => {
  function createApp(controller: MessageController): Hono {
    const app = new Hono();
    app.get("/api/messages/:id", (c) => controller.getById(c));
    app.post("/api/messages/:id/abort", (c) => controller.abort(c));
    return app;
  }

  it("returns 200 with DTO for existing message", async () => {
    const queryMessage = {
      getMessageById: async () => ({
        id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
        senderType: "user", senderId: "user-1",
        talkingStonePassedTo: ["otter-1"], status: "completed",
        body: "Hello",
        sequenceNum: 1, source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:01Z",
      }),
    } as unknown as QueryMessage;
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const queryOtter = { getById: async () => null } as unknown as QueryOtter;
    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo: { getActiveParticipants: async () => [], getUnreadMessages: async () => [], getTurnById: async () => null, updateLastReadTurnNumber: async () => {} } as unknown as ConversationRepository,
      queryMessage,
      queryOtter,
      logger: mockLogger,
      maxChainDepth: 20,
    });
    const ctrl = new MessageController({} as SendMessage, queryMessage, { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState, {} as AgentInvoker, mockLogger, queryOtter, dispatchChainEngine);
    const app = createApp(ctrl);
    const res = await app.request("/api/messages/msg-1");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.st).toBe("user");
    expect(json.si).toBe("user-1");
    expect(json.content).toBe("Hello");
  });

  it("returns 202 on abort for otter message", async () => {
    const queryMessage = {
      getMessageById: async () => ({
        id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
        senderType: "otter", senderId: "otter-1",
        talkingStonePassedTo: null, status: "streaming",
        body: null,
        sequenceNum: 2, source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: null,
      }),
    } as unknown as QueryMessage;
    const agentInvoker = { abort: () => {} } as unknown as AgentInvoker;
    const ctrl = new MessageController({} as SendMessage, queryMessage, { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState, agentInvoker, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }, { getById: async () => null } as unknown as QueryOtter, {} as DispatchChainEngine);
    const app = createApp(ctrl);
    const res = await app.request("/api/messages/msg-1/abort", { method: "POST" });
    expect(res.status).toBe(202);
    const json = await res.json() as Record<string, unknown>;
    expect(json.status).toBe("aborted");
  });

  it("returns 400 on abort for non-otter message", async () => {
    const queryMessage = {
      getMessageById: async () => ({
        id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
        senderType: "user", senderId: "user-1",
        talkingStonePassedTo: ["otter-1"], status: "completed",
        body: "Hello",
        sequenceNum: 1, source: "web",
      createdAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:01Z",
      }),
    } as unknown as QueryMessage;
    const agentInvoker = { abort: () => {} } as unknown as AgentInvoker;
    const ctrl = new MessageController({} as SendMessage, queryMessage, { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState, agentInvoker, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }, { getById: async () => null } as unknown as QueryOtter, {} as DispatchChainEngine);
    const app = createApp(ctrl);
    const res = await app.request("/api/messages/msg-1/abort", { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("MessageController sendMessage validation", () => {
  function createApp(controller: MessageController): Hono {
    const app = new Hono();
    app.post("/api/conversations/:id/messages", (c) => controller.sendMessage(c));
    return app;
  }

  it("returns 400 when senderId is missing", async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const queryOtter = { getById: async () => null } as unknown as QueryOtter;
    const conversationRepoStub = { getActiveParticipants: async () => [], getUnreadMessages: async () => [], getTurnById: async () => null, updateLastReadTurnNumber: async () => {} } as unknown as ConversationRepository;
    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo: conversationRepoStub,
      queryMessage: {} as QueryMessage,
      queryOtter,
      logger: mockLogger,
      maxChainDepth: 20,
    });
    const ctrl = new MessageController(
      {} as SendMessage,
      {} as QueryMessage,
      { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
      {} as AgentInvoker,
      mockLogger,
      queryOtter,
      dispatchChainEngine,
    );
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/conv-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ talkingStonePassedTo: ["otter-1"], body: "Hi" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is missing", async () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const queryOtter = { getById: async () => null } as unknown as QueryOtter;
    const conversationRepoStub = { getActiveParticipants: async () => [], getUnreadMessages: async () => [], getTurnById: async () => null, updateLastReadTurnNumber: async () => {} } as unknown as ConversationRepository;
    const dispatchChainEngine = new DispatchChainEngine({
      conversationRepo: conversationRepoStub,
      queryMessage: {} as QueryMessage,
      queryOtter,
      logger: mockLogger,
      maxChainDepth: 20,
    });
    const ctrl = new MessageController(
      {} as SendMessage,
      {} as QueryMessage,
      { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
      {} as AgentInvoker,
      mockLogger,
      queryOtter,
      dispatchChainEngine,
    );
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/conv-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: ["otter-1"] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("SettingsController", () => {
  const mockSettingsRepo: SettingsRepository = {
    get: async () => null,
    update: async () => {},
    getAll: async () => ({}),
  };

  it("returns config values", async () => {
    const ctrl = new SettingsController({
      provider: "openai", model: "gpt-4o", port: 3000,
      dbPath: "./otter-buddy.db", embeddingModelPath: "Xenova/bge-m3", embeddingDim: 1024,
    }, mockSettingsRepo, mockLogger());
    const app = new Hono();
    app.get("/api/settings", (c) => ctrl.getSettings(c));
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.provider).toBe("openai");
    expect(json.model).toBe("gpt-4o");
    expect(json.port).toBe(3000);
  });
});

describe("MemoryController", () => {
  const mockEntry: MemoryEntry = {
    id: "e1", layer: "working", contentType: "message",
    sourceId: "src-1", sourceTable: "messages", conversationId: null,
    granularity: "fine", content: "测试记忆内容", metadata: null,
    createdAt: "2026-07-16T00:00:00Z",
  };

  function createApp(searchMemory: SearchMemory, manageMemory: ManageMemory): Hono {
    const ctrl = new MemoryController(searchMemory, manageMemory, { available: true, embed: async () => new Float32Array(1024) }, mockLogger());
    const app = new Hono();
    app.get("/api/memory/search", (c) => ctrl.search(c));
    app.get("/api/memory/batch", (c) => ctrl.getDetails(c));
    return app;
  }

  it("search 支持 detail_level 参数并返回 snippet", async () => {
    const searchMemory = {
      search: async () => ({
        entries: [{ ...mockEntry, score: 1, source: "fts" as const, snippet: "测试<b>记忆</b>内容" }],
        total: 1,
      }),
    } as unknown as SearchMemory;
    const app = createApp(searchMemory, {} as ManageMemory);
    const res = await app.request("/api/memory/search?query=记忆&detail_level=snippet");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    const entries = json.entries as Record<string, unknown>[];
    expect(entries[0].snippet).toBe("测试<b>记忆</b>内容");
  });

  it("search detail_level=full 时不返回 snippet", async () => {
    const searchMemory = {
      search: async () => ({
        entries: [{ ...mockEntry, score: 1, source: "fts" as const }],
        total: 1,
      }),
    } as unknown as SearchMemory;
    const app = createApp(searchMemory, {} as ManageMemory);
    const res = await app.request("/api/memory/search?query=记忆&detail_level=full");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    const entries = json.entries as Record<string, unknown>[];
    expect(entries[0].snippet).toBeUndefined();
  });

  it("batch 返回指定条目的完整内容", async () => {
    const manageMemory = {
      getDetails: async () => [mockEntry],
    } as unknown as ManageMemory;
    const app = createApp({} as SearchMemory, manageMemory);
    const res = await app.request("/api/memory/batch?ids=e1");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.total).toBe(1);
    const entries = json.entries as Record<string, unknown>[];
    expect(entries[0].id).toBe("e1");
    expect(entries[0].content).toBe("测试记忆内容");
  });

  it("batch 缺少 ids 参数返回 400", async () => {
    const app = createApp({} as SearchMemory, {} as ManageMemory);
    const res = await app.request("/api/memory/batch");
    expect(res.status).toBe(400);
  });
});
