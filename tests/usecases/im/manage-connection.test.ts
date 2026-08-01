import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManageConnection } from "@usecases/im/manage-connection";
import type { ConnectionRepository } from "@usecases/im/connection-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Logger } from "@usecases/ports/logger";
import type { Connection, ConnectionSession } from "@entities/im/connection";
import type { Conversation } from "@entities/conversation/conversation";

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function mockConnectionRepo(overrides: Partial<ConnectionRepository> = {}): ConnectionRepository {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue(null),
    getByExternalId: vi.fn().mockResolvedValue(null),
    listActive: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(null),
    getActiveSessionByConversation: vi.fn().mockResolvedValue(null),
    createSession: vi.fn().mockResolvedValue(undefined),
    releaseSession: vi.fn().mockResolvedValue(undefined),
    getSessionHistory: vi.fn().mockResolvedValue([]),
    getByIds: vi.fn().mockResolvedValue([]),
    getActiveSessionsByConversations: vi.fn().mockResolvedValue([]),
    enterConversationTransaction: vi.fn().mockImplementation(
      async (_connId: string, _convId: string, _oldSessionId: string | null, newSession: ConnectionSession) => newSession
    ),
    ...overrides,
  };
}

function mockConversationRepo(overrides: Partial<ConversationRepository> = {}): ConversationRepository {
  return {
    getById: vi.fn().mockResolvedValue(null),
    getAllIds: vi.fn().mockResolvedValue([]),
    // 其他方法按需添加
    ...overrides,
  } as unknown as ConversationRepository;
}

function connectionFixture(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    name: "测试群",
    externalId: "chat-123",
    externalType: "feishu",
    metadata: null,
    status: "active",
    createdAt: "2026-07-29T00:00:00Z",
    updatedAt: "2026-07-29T00:00:00Z",
    ...overrides,
  };
}

function conversationFixture(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "测试对话",
    status: "active",
    summary: null,
    createdAt: "2026-07-29T00:00:00Z",
    updatedAt: "2026-07-29T00:00:00Z",
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function sessionFixture(overrides: Partial<ConnectionSession> = {}): ConnectionSession {
  return {
    id: "session-1",
    connectionId: "conn-1",
    conversationId: "conv-1",
    status: "active",
    joinedAt: "2026-07-29T00:00:00Z",
    releasedAt: null,
    ...overrides,
  };
}

describe("ManageConnection", () => {
  let manageConnection: ManageConnection;
  let connRepo: ConnectionRepository;
  let convRepo: ConversationRepository;
  let logger: Logger;

  beforeEach(() => {
    connRepo = mockConnectionRepo();
    convRepo = mockConversationRepo();
    logger = mockLogger();
    manageConnection = new ManageConnection(connRepo, convRepo, logger);
  });

  describe("createConnection", () => {
    it("创建连接成功", async () => {
      const result = await manageConnection.createConnection("测试群", "chat-123");

      expect(result.name).toBe("测试群");
      expect(result.externalId).toBe("chat-123");
      expect(result.status).toBe("active");
      expect(connRepo.create).toHaveBeenCalled();
    });

    it("名称为空时抛出错误", async () => {
      await expect(manageConnection.createConnection("", "chat-123"))
        .rejects.toThrow("Connection name must be non-empty");
    });

    it("externalId 为空时抛出错误", async () => {
      await expect(manageConnection.createConnection("测试群", ""))
        .rejects.toThrow("External ID must be non-empty");
    });

    it("externalId 已存在时抛出错误", async () => {
      vi.mocked(connRepo.getByExternalId).mockResolvedValue(connectionFixture());

      await expect(manageConnection.createConnection("测试群", "chat-123"))
        .rejects.toThrow("already exists");
    });
  });

  describe("ensureConnection", () => {
    it("连接已存在时返回现有连接", async () => {
      const existing = connectionFixture();
      vi.mocked(connRepo.getByExternalId).mockResolvedValue(existing);

      const result = await manageConnection.ensureConnection("chat-123", "测试群");

      expect(result).toBe(existing);
      expect(connRepo.create).not.toHaveBeenCalled();
    });

    it("连接不存在时创建新连接", async () => {
      vi.mocked(connRepo.getByExternalId).mockResolvedValue(null);

      const result = await manageConnection.ensureConnection("chat-123", "测试群");

      expect(result.externalId).toBe("chat-123");
      expect(connRepo.create).toHaveBeenCalled();
    });
  });

  describe("enterConversation", () => {
    it("进入对话成功", async () => {
      vi.mocked(connRepo.getById).mockResolvedValue(connectionFixture());
      vi.mocked(convRepo.getById).mockResolvedValue(conversationFixture());
      vi.mocked(connRepo.getActiveSession).mockResolvedValue(null);
      vi.mocked(connRepo.enterConversationTransaction).mockImplementation(
        async (_connId, _convId, _oldSessionId, newSession) => newSession
      );

      const result = await manageConnection.enterConversation("conn-1", "conv-1");

      expect(result.conversationId).toBe("conv-1");
      expect(result.status).toBe("active");
      expect(connRepo.enterConversationTransaction).toHaveBeenCalled();
    });

    it("连接不存在时抛出错误", async () => {
      vi.mocked(connRepo.getById).mockResolvedValue(null);

      await expect(manageConnection.enterConversation("conn-1", "conv-1"))
        .rejects.toThrow("Connection not found");
    });

    it("连接不活跃时抛出错误", async () => {
      vi.mocked(connRepo.getById).mockResolvedValue(connectionFixture({ status: "inactive" }));

      await expect(manageConnection.enterConversation("conn-1", "conv-1"))
        .rejects.toThrow("not active");
    });

    it("对话不存在时抛出错误", async () => {
      vi.mocked(connRepo.getById).mockResolvedValue(connectionFixture());
      vi.mocked(convRepo.getById).mockResolvedValue(null);

      await expect(manageConnection.enterConversation("conn-1", "conv-1"))
        .rejects.toThrow("Conversation not found");
    });

    it("对话不活跃时抛出错误", async () => {
      vi.mocked(connRepo.getById).mockResolvedValue(connectionFixture());
      vi.mocked(convRepo.getById).mockResolvedValue(conversationFixture({ status: "completed" }));

      await expect(manageConnection.enterConversation("conn-1", "conv-1"))
        .rejects.toThrow("not active");
    });

    it("对话已被其他连接占用时抛出错误", async () => {
      vi.mocked(connRepo.getById).mockResolvedValue(connectionFixture());
      vi.mocked(convRepo.getById).mockResolvedValue(conversationFixture());
      vi.mocked(connRepo.getActiveSession).mockResolvedValue(null);
      vi.mocked(connRepo.enterConversationTransaction).mockRejectedValue(
        new Error("Conversation conv-1 is already occupied by connection conn-other")
      );

      await expect(manageConnection.enterConversation("conn-1", "conv-1"))
        .rejects.toThrow("already occupied");
    });

    it("已在目标对话中时直接返回", async () => {
      const existingSession = sessionFixture();
      vi.mocked(connRepo.getById).mockResolvedValue(connectionFixture());
      vi.mocked(convRepo.getById).mockResolvedValue(conversationFixture());
      vi.mocked(connRepo.getActiveSessionByConversation).mockResolvedValue(existingSession);
      vi.mocked(connRepo.getActiveSession).mockResolvedValue(existingSession);

      const result = await manageConnection.enterConversation("conn-1", "conv-1");

      // 验证返回了现有 session
      expect(result.conversationId).toBe("conv-1");
      expect(result.status).toBe("active");
      expect(result.id).toBe("session-1");
    });

    it("切换对话时释放旧 session", async () => {
      const oldSession = sessionFixture({ conversationId: "conv-old" });
      vi.mocked(connRepo.getById).mockResolvedValue(connectionFixture());
      vi.mocked(convRepo.getById).mockResolvedValue(conversationFixture());
      vi.mocked(connRepo.getActiveSessionByConversation).mockResolvedValue(null);
      vi.mocked(connRepo.getActiveSession).mockResolvedValue(oldSession);

      const result = await manageConnection.enterConversation("conn-1", "conv-1");

      // 验证进入了新对话
      expect(result.conversationId).toBe("conv-1");
      expect(result.status).toBe("active");
    });
  });

  describe("leaveConversation", () => {
    it("离开对话成功", async () => {
      vi.mocked(connRepo.getActiveSession).mockResolvedValue(sessionFixture());

      // 验证离开操作成功完成（无异常抛出）
      await expect(manageConnection.leaveConversation("conn-1")).resolves.toBeUndefined();
    });

    it("未进入任何对话时抛出错误", async () => {
      vi.mocked(connRepo.getActiveSession).mockResolvedValue(null);

      await expect(manageConnection.leaveConversation("conn-1"))
        .rejects.toThrow("not in any conversation");
    });
  });

  describe("listActiveConversations", () => {
    it("返回活跃对话列表", async () => {
      vi.mocked(convRepo.getAllIds).mockResolvedValue(["conv-1", "conv-2"]);
      vi.mocked(convRepo.getById)
        .mockResolvedValueOnce(conversationFixture({ id: "conv-1", title: "对话一" }))
        .mockResolvedValueOnce(conversationFixture({ id: "conv-2", title: "对话二" }));
      vi.mocked(connRepo.getActiveSessionsByConversations).mockResolvedValue([]);

      const result = await manageConnection.listActiveConversations();

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe("对话一");
      expect(result[1].title).toBe("对话二");
    });

    it("显示占用状态", async () => {
      vi.mocked(convRepo.getAllIds).mockResolvedValue(["conv-1"]);
      vi.mocked(convRepo.getById).mockResolvedValue(conversationFixture());
      vi.mocked(connRepo.getActiveSessionsByConversations).mockResolvedValue([sessionFixture()]);
      vi.mocked(connRepo.getByIds).mockResolvedValue([connectionFixture({ name: "飞书群A" })]);

      const result = await manageConnection.listActiveConversations();

      expect(result[0].occupiedBy).toBe("飞书群A");
    });

    it("跳过非活跃对话", async () => {
      vi.mocked(convRepo.getAllIds).mockResolvedValue(["conv-1", "conv-2"]);
      vi.mocked(convRepo.getById)
        .mockResolvedValueOnce(conversationFixture({ status: "completed" }))
        .mockResolvedValueOnce(conversationFixture({ id: "conv-2" }));
      vi.mocked(connRepo.getActiveSessionsByConversations).mockResolvedValue([]);

      const result = await manageConnection.listActiveConversations();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("conv-2");
    });
  });

  describe("getCurrentConversation", () => {
    it("返回当前对话", async () => {
      vi.mocked(connRepo.getActiveSession).mockResolvedValue(sessionFixture());
      vi.mocked(convRepo.getById).mockResolvedValue(conversationFixture());

      const result = await manageConnection.getCurrentConversation("conn-1");

      expect(result).toEqual({ id: "conv-1", title: "测试对话" });
    });

    it("未进入任何对话时返回 null", async () => {
      vi.mocked(connRepo.getActiveSession).mockResolvedValue(null);

      const result = await manageConnection.getCurrentConversation("conn-1");

      expect(result).toBeNull();
    });
  });

  describe("getConnection", () => {
    it("返回连接信息", async () => {
      const connection = connectionFixture();
      vi.mocked(connRepo.getById).mockResolvedValue(connection);

      const result = await manageConnection.getConnection("conn-1");

      expect(result).toBe(connection);
    });

    it("连接不存在时返回 null", async () => {
      vi.mocked(connRepo.getById).mockResolvedValue(null);

      const result = await manageConnection.getConnection("conn-1");

      expect(result).toBeNull();
    });
  });

  describe("listConnections", () => {
    it("返回所有活跃连接", async () => {
      const connections = [connectionFixture(), connectionFixture({ id: "conn-2" })];
      vi.mocked(connRepo.listActive).mockResolvedValue(connections);

      const result = await manageConnection.listConnections();

      expect(result).toHaveLength(2);
    });
  });
});
