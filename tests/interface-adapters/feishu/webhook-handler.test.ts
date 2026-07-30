import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeishuWebhookHandler } from "@interface-adapters/feishu/webhook-handler";
import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { CommandDispatcher } from "@interface-adapters/feishu/command-dispatcher";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { Logger } from "@usecases/ports/logger";
import type { Context } from "hono";

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function mockContext(body: string, headers: Record<string, string> = {}): Context & { _jsonCalls: unknown[][] } {
  const jsonCalls: unknown[][] = [];
  return {
    req: {
      text: vi.fn().mockResolvedValue(body),
      header: vi.fn((name: string) => headers[name] ?? ""),
    },
    json: vi.fn((...args: unknown[]) => {
      jsonCalls.push(args);
      return new Response();
    }),
    _jsonCalls: jsonCalls,
  } as any;
}

describe("FeishuWebhookHandler", () => {
  let handler: FeishuWebhookHandler;
  let manageConnection: ManageConnection;
  let sendMessage: SendMessage;
  let commandDispatcher: CommandDispatcher;
  let feishuGateway: FeishuGateway;
  let logger: Logger;
  let sendMock: ReturnType<typeof vi.fn>;
  let dispatchMock: ReturnType<typeof vi.fn>;
  let replyTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMock = vi.fn().mockResolvedValue({ id: "msg-1" });
    dispatchMock = vi.fn().mockResolvedValue(undefined);
    replyTextMock = vi.fn().mockResolvedValue(undefined);

    manageConnection = {
      ensureConnection: vi.fn().mockResolvedValue({ id: "conn-1", name: "test" }),
      getCurrentConversation: vi.fn().mockResolvedValue(null),
    } as any;
    sendMessage = { send: sendMock } as any;
    commandDispatcher = { dispatch: dispatchMock } as any;
    feishuGateway = {
      replyText: replyTextMock,
      verifySignature: vi.fn().mockReturnValue(true),
    };
    logger = mockLogger();

    handler = new FeishuWebhookHandler({
      manageConnection,
      sendMessage,
      commandDispatcher,
      feishuGateway,
      config: { verificationToken: "test-token" },
      logger,
    });
  });

  describe("handle", () => {
    it("challenge 请求返回 challenge", async () => {
      const event = {
        challenge: "test-challenge",
        token: "test-token",
      };
      const ctx = mockContext(JSON.stringify(event));

      await handler.handle(ctx);

      // 验证返回 challenge
      expect(ctx._jsonCalls[0][0]).toEqual({ challenge: "test-challenge" });
    });

    it("无效 token 返回 403", async () => {
      const event = {
        header: { token: "invalid-token" },
      };
      const ctx = mockContext(JSON.stringify(event));

      await handler.handle(ctx);

      // 验证返回 403
      expect(ctx._jsonCalls[0]).toEqual([{ error: "Invalid token" }, 403]);
    });

    it("机器人消息被忽略", async () => {
      const event = {
        header: {
          token: "test-token",
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "msg-1",
            chat_id: "chat-1",
            message_type: "text",
            content: JSON.stringify({ text: "你好" }),
          },
          sender: {
            sender_id: { open_id: "bot-1" },
            sender_type: "app",
          },
        },
      };
      const ctx = mockContext(JSON.stringify(event));

      await handler.handle(ctx);

      // 验证消息未发送
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("命令消息分发到 CommandDispatcher", async () => {
      const event = {
        header: {
          token: "test-token",
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "msg-1",
            chat_id: "chat-1",
            message_type: "text",
            content: JSON.stringify({ text: "/list" }),
          },
          sender: {
            sender_id: { open_id: "user-1" },
            sender_type: "user",
          },
        },
      };
      const ctx = mockContext(JSON.stringify(event));

      await handler.handle(ctx);

      // 验证命令被分发
      expect(dispatchMock).toHaveBeenCalled();
    });

    it("普通消息发送到 Conversation", async () => {
      vi.mocked(manageConnection.getCurrentConversation).mockResolvedValue({
        id: "conv-1",
        title: "测试对话",
      });

      const event = {
        header: {
          token: "test-token",
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "msg-1",
            chat_id: "chat-1",
            message_type: "text",
            content: JSON.stringify({ text: "你好" }),
          },
          sender: {
            sender_id: { open_id: "user-1" },
            sender_type: "user",
          },
        },
      };
      const ctx = mockContext(JSON.stringify(event));

      await handler.handle(ctx);

      // 验证消息发送成功
      expect(sendMock).toHaveBeenCalled();
    });

    it("未进入对话时返回提示", async () => {
      vi.mocked(manageConnection.getCurrentConversation).mockResolvedValue(null);

      const event = {
        header: {
          token: "test-token",
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "msg-1",
            chat_id: "chat-1",
            message_type: "text",
            content: JSON.stringify({ text: "你好" }),
          },
          sender: {
            sender_id: { open_id: "user-1" },
            sender_type: "user",
          },
        },
      };
      const ctx = mockContext(JSON.stringify(event));

      await handler.handle(ctx);

      // 验证返回提示信息
      expect(replyTextMock).toHaveBeenCalled();
      const [chatId, text] = replyTextMock.mock.calls[0];
      expect(chatId).toBe("chat-1");
      expect(text).toContain("当前未进入任何对话");
    });

    it("签名验证失败返回 403", async () => {
      vi.mocked(feishuGateway.verifySignature).mockReturnValue(false);

      const event = {
        header: {
          token: "test-token",
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "msg-1",
            chat_id: "chat-1",
            message_type: "text",
            content: JSON.stringify({ text: "你好" }),
          },
          sender: {
            sender_id: { open_id: "user-1" },
            sender_type: "user",
          },
        },
      };
      const ctx = mockContext(JSON.stringify(event), {
        "X-Lark-Signature": "invalid-signature",
      });

      await handler.handle(ctx);

      // 验证返回 403
      expect(ctx._jsonCalls[0]).toEqual([{ error: "Invalid signature" }, 403]);
    });
  });
});
