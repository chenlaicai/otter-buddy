import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeishuWebhookHandler } from "@interface-adapters/feishu/webhook-handler";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuMessageProcessor } from "@interface-adapters/feishu/message-processor";
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
  let feishuGateway: FeishuGateway;
  let logger: Logger;
  let messageProcessor: FeishuMessageProcessor;

  beforeEach(() => {
    feishuGateway = {
      replyText: vi.fn().mockResolvedValue(undefined),
      verifySignature: vi.fn().mockReturnValue(true),
      decryptEventData: vi.fn().mockImplementation((data: string) => data),
    };
    logger = mockLogger();

    messageProcessor = {
      process: vi.fn().mockResolvedValue(undefined),
    } as any;

    handler = new FeishuWebhookHandler({
      messageProcessor,
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

      expect(ctx._jsonCalls[0][0]).toEqual({ challenge: "test-challenge" });
    });

    it("无效 token 返回 403", async () => {
      const event = {
        header: { token: "invalid-token" },
      };
      const ctx = mockContext(JSON.stringify(event));

      await handler.handle(ctx);

      expect(ctx._jsonCalls[0]).toEqual([{ error: "Invalid token" }, 403]);
    });

    it("加密事件正确解密处理", async () => {
      const innerEvent = {
        header: {
          token: "test-token",
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "msg-1",
            chat_id: "chat-1",
            message_type: "text",
            content: JSON.stringify({ text: "加密消息" }),
          },
          sender: {
            sender_id: { open_id: "user-1" },
            sender_type: "user",
          },
        },
      };
      const encryptedData = "encrypted-base64-data";
      const event = { encrypt: encryptedData };
      const ctx = mockContext(JSON.stringify(event));

      vi.mocked(feishuGateway.decryptEventData).mockReturnValue(JSON.stringify(innerEvent));

      await handler.handle(ctx);

      expect(feishuGateway.decryptEventData).toHaveBeenCalled();
      expect(messageProcessor.process).toHaveBeenCalled();
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

      expect(messageProcessor.process).not.toHaveBeenCalled();
    });

    it("命令消息分发到消息处理器", async () => {
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

      expect(messageProcessor.process).toHaveBeenCalled();
    });

    it("普通消息发送到消息处理器", async () => {
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

      expect(messageProcessor.process).toHaveBeenCalled();
    });

    it("非文本消息被忽略", async () => {
      const event = {
        header: {
          token: "test-token",
          event_type: "im.message.receive_v1",
        },
        event: {
          message: {
            message_id: "msg-1",
            chat_id: "chat-1",
            message_type: "image",
            content: JSON.stringify({ image_key: "xxx" }),
          },
          sender: {
            sender_id: { open_id: "user-1" },
            sender_type: "user",
          },
        },
      };
      const ctx = mockContext(JSON.stringify(event));

      await handler.handle(ctx);

      expect(messageProcessor.process).not.toHaveBeenCalled();
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

      expect(ctx._jsonCalls[0]).toEqual([{ error: "Invalid signature" }, 403]);
    });
  });
});
