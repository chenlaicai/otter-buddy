import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { ConversationController } from "@interface-adapters/http/controllers/conversation-controller";
import { OtterController } from "@interface-adapters/http/controllers/otter-controller";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import { SettingsController } from "@interface-adapters/http/controllers/settings-controller";
import type { ManageConversation } from "@usecases/conversation/manage-conversation";
import type { ManageParticipant } from "@usecases/conversation/manage-participant";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { DissolveOtter } from "@usecases/otter/dissolve-otter";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { Conversation } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";

function mockConversation(): Conversation {
  return {
    id: "conv-1", title: "Test", status: "active", summary: null,
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
    return app;
  }

  it("returns 200 with DTO for existing conversation", async () => {
    const manageConv = { getById: async () => mockConversation() } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant);
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/conv-1");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.id).toBe("conv-1");
    expect(json.title).toBe("Test");
  });

  it("returns 404 for non-existent conversation", async () => {
    const manageConv = { getById: async () => null } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant);
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 201 on create", async () => {
    const manageConv = {
      create: async () => mockConversation(),
    } as unknown as ManageConversation;
    const ctrl = new ConversationController(manageConv, {} as ManageParticipant);
    const app = createApp(ctrl);
    const res = await app.request("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test" }),
    });
    expect(res.status).toBe(201);
    const json = await res.json() as Record<string, unknown>;
    expect(json.title).toBe("Test");
  });
});

describe("OtterController", () => {
  function createApp(controller: OtterController): Hono {
    const app = new Hono();
    app.get("/api/otters/big", (c) => controller.getBigOtter(c));
    app.get("/api/otters/:id", (c) => controller.getById(c));
    return app;
  }

  it("returns 200 with DTO for big otter", async () => {
    const queryOtter = { getBigOtter: async () => mockOtter() } as unknown as QueryOtter;
    const ctrl = new OtterController({} as CreateOtter, {} as DissolveOtter, {} as ManageSession, queryOtter);
    const app = createApp(ctrl);
    const res = await app.request("/api/otters/big");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.name).toBe("Big Otter");
    expect(json.type).toBe("big");
  });

  it("returns 404 for non-existent otter", async () => {
    const queryOtter = { getById: async () => null } as unknown as QueryOtter;
    const ctrl = new OtterController({} as CreateOtter, {} as DissolveOtter, {} as ManageSession, queryOtter);
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
        body: "Hello", attachments: null,
        sequenceNum: 1, createdAt: "2026-07-16T00:00:00Z", completedAt: "2026-07-16T00:00:01Z",
      }),
    } as unknown as QueryMessage;
    const ctrl = new MessageController({} as SendMessage, queryMessage, {} as AgentInvoker);
    const app = createApp(ctrl);
    const res = await app.request("/api/messages/msg-1");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.st).toBe("user");
    expect(json.si).toBe("user-1");
    expect(json.content).toBe("Hello");
  });

  it("returns 202 on abort", async () => {
    const queryMessage = {
      getMessageById: async () => ({
        id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
        senderType: "otter", senderId: "otter-1",
        talkingStonePassedTo: null, status: "streaming",
        body: null, attachments: null,
        sequenceNum: 2, createdAt: "2026-07-16T00:00:00Z", completedAt: null,
      }),
    } as unknown as QueryMessage;
    const agentInvoker = { abort: () => {} } as unknown as AgentInvoker;
    const ctrl = new MessageController({} as SendMessage, queryMessage, agentInvoker);
    const app = createApp(ctrl);
    const res = await app.request("/api/messages/msg-1/abort", { method: "POST" });
    expect(res.status).toBe(202);
    const json = await res.json() as Record<string, unknown>;
    expect(json.status).toBe("aborted");
  });
});

describe("SettingsController", () => {
  it("returns config values", async () => {
    const ctrl = new SettingsController({
      provider: "openai", model: "gpt-4o", port: 3000,
      dbPath: "./otter-buddy.db", embeddingModelPath: "Xenova/bge-m3", embeddingDim: 1024,
    });
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
