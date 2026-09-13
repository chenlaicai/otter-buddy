import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandDispatcher } from "@interface-adapters/feishu/command-dispatcher";
import type { ManageConnection } from "@usecases/im/manage-connection";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { Logger } from "@usecases/ports/logger";
import { createTestLogger } from "../../helpers/logger";

describe("CommandDispatcher", () => {
  let dispatcher: CommandDispatcher;
  let manageConnection: ManageConnection;
  let entryRepo: EntryRepository;
  let feishuGateway: FeishuGateway;
  let logger: Logger;
  let replyTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    replyTextMock = vi.fn().mockResolvedValue(undefined);
    manageConnection = {
      listActiveConversations: vi.fn().mockResolvedValue([]),
      enterConversation: vi.fn().mockResolvedValue({ id: "session-1" }),
      getCurrentConversation: vi.fn().mockResolvedValue(null),
    } as any;
    // F20260913ctlv 批4a：/history 数据源切 entries
    entryRepo = {
      getEntries: vi.fn().mockResolvedValue([]),
    } as any;
    feishuGateway = {
      replyText: replyTextMock as any,
      replyMarkdown: vi.fn(),
    };
    logger = createTestLogger();
    dispatcher = new CommandDispatcher(manageConnection, entryRepo, feishuGateway, logger);
  });

  describe("/list 命令", () => {
    it("空列表返回提示", async () => {
      await dispatcher.dispatch("conn-1", "/list", "chat-1");

      // 验证返回值包含提示信息
      expect(replyTextMock).toHaveBeenCalled();
      const [chatId, text] = replyTextMock.mock.calls[0];
      expect(chatId).toBe("chat-1");
      expect(text).toContain("当前没有活跃的对话");
    });

    it("返回对话列表", async () => {
      vi.mocked(manageConnection.listActiveConversations).mockResolvedValue([
        { id: "conv-1", title: "对话一" },
        { id: "conv-2", title: "对话二", occupiedBy: "飞书群A" },
      ]);

      await dispatcher.dispatch("conn-1", "/list", "chat-1");

      // 验证返回值包含对话信息
      expect(replyTextMock).toHaveBeenCalled();
      const [chatId, text] = replyTextMock.mock.calls[0];
      expect(chatId).toBe("chat-1");
      expect(text).toContain("对话一");
      expect(text).toContain("飞书群A");
    });
  });

  describe("/in 命令", () => {
    it("进入对话成功", async () => {
      await dispatcher.dispatch("conn-1", "/in conv-1", "chat-1");

      // 验证返回值包含成功信息
      expect(replyTextMock).toHaveBeenCalled();
      const [chatId, text] = replyTextMock.mock.calls[0];
      expect(chatId).toBe("chat-1");
      expect(text).toContain("已进入对话");
    });

    it("进入对话失败返回错误", async () => {
      vi.mocked(manageConnection.enterConversation).mockRejectedValue(
        new Error("Conversation not found")
      );

      await dispatcher.dispatch("conn-1", "/in conv-1", "chat-1");

      // 验证返回值包含错误信息
      expect(replyTextMock).toHaveBeenCalled();
      const [chatId, text] = replyTextMock.mock.calls[0];
      expect(chatId).toBe("chat-1");
      expect(text).toContain("进入对话失败");
    });
  });

  describe("/history 命令", () => {
    it("未进入对话时返回提示", async () => {
      vi.mocked(manageConnection.getCurrentConversation).mockResolvedValue(null);

      await dispatcher.dispatch("conn-1", "/history", "chat-1");

      // 验证返回值包含提示信息
      expect(replyTextMock).toHaveBeenCalled();
      const [chatId, text] = replyTextMock.mock.calls[0];
      expect(chatId).toBe("chat-1");
      expect(text).toContain("当前未进入任何对话");
    });

    it("返回历史消息", async () => {
      vi.mocked(manageConnection.getCurrentConversation).mockResolvedValue({
        id: "conv-1",
        title: "测试对话",
      });
      vi.mocked(entryRepo.getEntries).mockResolvedValue([
        {
          id: "entry-1",
          conversationId: "conv-1",
          sequenceNum: 1,
          entryType: "user",
          senderType: "user",
          senderId: "user-1",
          body: "你好",
          invokeId: null,
          yieldTargets: null,
          turnId: "turn-1",
          status: "completed",
          source: "feishu",
          metadata: null,
          senderName: "",
          contextTokens: null,
          contextTokensMax: null,
          createdAt: "2026-07-30T10:00:00Z",
          completedAt: "2026-07-30T10:00:00Z",
        } as never,
      ]);

      await dispatcher.dispatch("conn-1", "/history", "chat-1");

      // 验证返回值包含消息内容
      expect(replyTextMock).toHaveBeenCalled();
      const [chatId, text] = replyTextMock.mock.calls[0];
      expect(chatId).toBe("chat-1");
      expect(text).toContain("你好");
    });
  });

  describe("/help 命令", () => {
    it("返回帮助信息", async () => {
      await dispatcher.dispatch("conn-1", "/help", "chat-1");

      // 验证返回值包含帮助信息
      expect(replyTextMock).toHaveBeenCalled();
      const [chatId, text] = replyTextMock.mock.calls[0];
      expect(chatId).toBe("chat-1");
      expect(text).toContain("/list");
    });
  });

  describe("未知命令", () => {
    it("返回错误提示和帮助", async () => {
      await dispatcher.dispatch("conn-1", "/unknown", "chat-1");

      // 验证返回值包含错误信息
      expect(replyTextMock).toHaveBeenCalled();
      const [chatId, text] = replyTextMock.mock.calls[0];
      expect(chatId).toBe("chat-1");
      expect(text).toContain("未知命令");
    });
  });
});
