import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConnectionRepository } from "@frameworks/db/im/sqlite-connection-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { ManageConnection } from "@usecases/im/manage-connection";
import { ConnectionController } from "@interface-adapters/http/controllers/connection-controller";
import { vi } from "vitest";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  // 添加 source 列
  db.prepare("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'web'").run();
  return db;
}

function seedConversation(db: Database.Database, id: string, title: string): void {
  db.prepare(`
    INSERT INTO conversations (id, title, status, created_at, updated_at)
    VALUES (?, ?, 'active', datetime('now'), datetime('now'))
  `).run(id, title);
}

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
}

describe("Connection API", () => {
  let db: Database.Database;
  let connRepo: SqliteConnectionRepository;
  let convRepo: SqliteConversationRepository;
  let manageConnection: ManageConnection;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    connRepo = new SqliteConnectionRepository(db);
    convRepo = new SqliteConversationRepository(db);
    manageConnection = new ManageConnection(connRepo, convRepo, mockLogger() as any);

    // 创建一个简单的测试 app，只注册 connection 路由
    app = new Hono();
    const connectionCtrl = new ConnectionController(manageConnection);
    app.get("/api/connections", (ctx) => connectionCtrl.list(ctx));
    app.post("/api/connections", (ctx) => connectionCtrl.create(ctx));
    app.get("/api/connections/:id", (ctx) => connectionCtrl.getById(ctx));
    app.get("/api/connections/:id/session", (ctx) => connectionCtrl.getSession(ctx));
    app.post("/api/connections/:id/enter", (ctx) => connectionCtrl.enterConversation(ctx));
    app.post("/api/connections/:id/leave", (ctx) => connectionCtrl.leaveConversation(ctx));
    app.get("/api/connections/:id/conversations", (ctx) => connectionCtrl.listActiveConversations(ctx));
  });

  afterEach(() => {
    db.close();
  });

  describe("POST /api/connections", () => {
    it("创建连接成功", async () => {
      const res = await app.request("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "测试群", externalId: "chat-123" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("测试群");
      expect(body.externalId).toBe("chat-123");
      expect(body.status).toBe("active");
    });

    it("名称为空时返回 400", async () => {
      const res = await app.request("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", externalId: "chat-123" }),
      });

      expect(res.status).toBe(400);
    });

    it("externalId 重复时返回 409", async () => {
      await manageConnection.createConnection("群1", "chat-123");

      const res = await app.request("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "群2", externalId: "chat-123" }),
      });

      expect(res.status).toBe(409);
    });
  });

  describe("GET /api/connections", () => {
    it("返回空列表", async () => {
      const res = await app.request("/api/connections");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("返回所有连接", async () => {
      await manageConnection.createConnection("群1", "chat-1");
      await manageConnection.createConnection("群2", "chat-2");

      const res = await app.request("/api/connections");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  describe("GET /api/connections/:id", () => {
    it("返回连接详情", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");

      const res = await app.request(`/api/connections/${conn.id}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("测试群");
    });

    it("连接不存在时返回 404", async () => {
      const res = await app.request("/api/connections/non-existent");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/connections/:id/enter", () => {
    it("进入对话成功", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");
      seedConversation(db, "conv-1", "测试对话");

      const res = await app.request(`/api/connections/${conn.id}/enter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "conv-1" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.conversationId).toBe("conv-1");
      expect(body.status).toBe("active");
    });

    it("对话不存在时返回 404", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");

      const res = await app.request(`/api/connections/${conn.id}/enter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "non-existent" }),
      });

      expect(res.status).toBe(404);
    });

    it("对话已被占用时返回 409", async () => {
      const conn1 = await manageConnection.createConnection("群1", "chat-1");
      const conn2 = await manageConnection.createConnection("群2", "chat-2");
      seedConversation(db, "conv-1", "测试对话");

      await manageConnection.enterConversation(conn1.id, "conv-1");

      const res = await app.request(`/api/connections/${conn2.id}/enter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "conv-1" }),
      });

      expect(res.status).toBe(409);
    });
  });

  describe("POST /api/connections/:id/leave", () => {
    it("离开对话成功", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");
      seedConversation(db, "conv-1", "测试对话");
      await manageConnection.enterConversation(conn.id, "conv-1");

      const res = await app.request(`/api/connections/${conn.id}/leave`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("left");
    });

    it("未进入对话时返回 400", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");

      const res = await app.request(`/api/connections/${conn.id}/leave`, {
        method: "POST",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/connections/:id/session", () => {
    it("返回当前 session", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");
      seedConversation(db, "conv-1", "测试对话");
      await manageConnection.enterConversation(conn.id, "conv-1");

      const res = await app.request(`/api/connections/${conn.id}/session`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("conv-1");
      expect(body.title).toBe("测试对话");
    });

    it("未进入对话时返回 404", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");

      const res = await app.request(`/api/connections/${conn.id}/session`);

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/connections/:id/conversations", () => {
    it("返回活跃对话列表", async () => {
      seedConversation(db, "conv-1", "对话一");
      seedConversation(db, "conv-2", "对话二");

      const res = await app.request("/api/connections/any/conversations");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
    });

    it("显示占用状态", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");
      seedConversation(db, "conv-1", "对话一");
      await manageConnection.enterConversation(conn.id, "conv-1");

      const res = await app.request("/api/connections/any/conversations");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body[0].occupiedBy).toBe("测试群");
    });
  });
});
