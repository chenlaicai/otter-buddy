import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConnectionRepository } from "@frameworks/db/im/sqlite-connection-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { ManageConnection } from "@usecases/im/manage-connection";
import { ConnectionController } from "@interface-adapters/http/controllers/connection-controller";
import { createTestLogger } from "../helpers/logger";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function seedConversation(db: Database.Database, id: string, title: string): void {
  db.prepare(`
    INSERT INTO conversations (id, title, status, created_at, updated_at)
    VALUES (?, ?, 'active', datetime('now'), datetime('now'))
  `).run(id, title);
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
    manageConnection = new ManageConnection(connRepo, convRepo, createTestLogger() as any);

    // 创建一个简单的测试 app，只注册 connection 路由
    app = new Hono();
    const connectionCtrl = new ConnectionController(manageConnection, createTestLogger() as any);
    app.get("/api/connections/:id", (ctx) => connectionCtrl.getById(ctx));
    app.post("/api/connections/:id/enter", (ctx) => connectionCtrl.enterConversation(ctx));
    app.get("/api/connections/:id/conversations", (ctx) => connectionCtrl.listActiveConversations(ctx));
  });

  afterEach(() => {
    db.close();
  });

  // F20261023cnct（issue #1063）：POST /api/connections 与 GET /api/connections 的用例随死端点下线删除
  describe("GET /api/connections/:id", () => {
    it("返回连接详情", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");

      const res = await app.request(`/api/connections/${conn.id}`);

      expect(res.status).toBe(200);
      const body = await res.json() as any;
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
      const body = await res.json() as any;
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

  // F20261023cnct（issue #1063）：POST :id/leave 与 GET :id/session 的用例随死端点下线删除
  describe("GET /api/connections/:id/conversations", () => {
    it("返回活跃对话列表", async () => {
      seedConversation(db, "conv-1", "对话一");
      seedConversation(db, "conv-2", "对话二");

      const res = await app.request("/api/connections/any/conversations");

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toHaveLength(2);
    });

    it("显示占用状态", async () => {
      const conn = await manageConnection.createConnection("测试群", "chat-123");
      seedConversation(db, "conv-1", "对话一");
      await manageConnection.enterConversation(conn.id, "conv-1");

      const res = await app.request("/api/connections/any/conversations");

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body[0].occupiedBy).toBe("测试群");
    });
  });

  // F20261023cnct（issue #1063）：关闭标准验证断言「下线后契约测试无残留引用」的机械化固化。
  // 双重断言：生产 router 源文本零死端点注册 + ConnectionController 方法面零死方法。
  // usecase ManageConnection 不在断言面（有意保留给 IM 命令体系，见 manage-connection.ts）。
  describe("死端点已下线（issue #1063 契约无残留断言）", () => {
    it("生产 router.ts 不再注册 4 个死端点", () => {
      const routerSource = readFileSync(
        new URL("../../src/interface-adapters/http/router.ts", import.meta.url),
        "utf8",
      );
      expect(routerSource).not.toContain('app.get("/api/connections"');
      expect(routerSource).not.toContain('app.post("/api/connections"');
      expect(routerSource).not.toContain('"/api/connections/:id/session"');
      expect(routerSource).not.toContain('"/api/connections/:id/leave"');
    });

    it("ConnectionController 方法面零死方法（usecase 方法保留）", () => {
      const proto = ConnectionController.prototype as unknown as Record<string, unknown>;
      expect(proto.list).toBeUndefined();
      expect(proto.create).toBeUndefined();
      expect(proto.getSession).toBeUndefined();
      expect(proto.leaveConversation).toBeUndefined();
      // 存活方法仍在
      expect(typeof proto.getById).toBe("function");
      expect(typeof proto.enterConversation).toBe("function");
      expect(typeof proto.listActiveConversations).toBe("function");
    });

    it("usecase ManageConnection 方法保留给命令体系", () => {
      const proto = ManageConnection.prototype as unknown as Record<string, unknown>;
      expect(typeof proto.leaveConversation).toBe("function");
      expect(typeof proto.listConnections).toBe("function");
      expect(typeof proto.createConnection).toBe("function");
    });
  });
});
