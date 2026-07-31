import type { Context } from "hono";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuMessageProcessor } from "./message-processor";
import type { Logger } from "@usecases/ports/logger";

interface FeishuEvent {
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event?: {
    message?: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      create_time: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{
        key: string;
        id: {
          union_id: string;
          user_id: string;
          open_id: string;
        };
        name: string;
        tenant_key: string;
      }>;
    };
    sender?: {
      sender_id: {
        union_id: string;
        user_id: string;
        open_id: string;
      };
      sender_type: string;
      tenant_key: string;
    };
  };
  challenge?: string;
  token?: string;
  type?: string;
  encrypt?: string;
}

export interface FeishuWebhookConfig {
  verificationToken: string;
}

export class FeishuWebhookHandler {
  constructor(
    private readonly deps: {
      messageProcessor: FeishuMessageProcessor;
      feishuGateway: FeishuGateway;
      config: FeishuWebhookConfig;
      logger: Logger;
    },
  ) {}

  async handle(c: Context): Promise<Response> {
    try {
      const body = await c.req.text();
      let event = JSON.parse(body) as FeishuEvent;

      // 处理加密事件
      if (event.encrypt) {
        const decrypted = this.deps.feishuGateway.decryptEventData(event.encrypt);
        event = JSON.parse(decrypted) as FeishuEvent;
      }

      const authError = this.authenticateRequest(c, event, body);
      if (authError) return authError;

      if (event.challenge) {
        return c.json({ challenge: event.challenge });
      }

      if (event.header?.event_type === "im.message.receive_v1" && event.event?.message) {
        await this.handleMessage(event);
      }

      return c.json({ code: 0 });
    } catch (err) {
      this.deps.logger.error("Feishu webhook error", err instanceof Error ? err : undefined);
      return c.json({ error: "Internal server error" }, 500);
    }
  }

  private authenticateRequest(c: Context, event: FeishuEvent, body: string): Response | null {
    const token = event.header?.token ?? event.token;
    if (token !== this.deps.config.verificationToken) {
      this.deps.logger.warn("Invalid Feishu verification token");
      return c.json({ error: "Invalid token" }, 403);
    }

    const signature = c.req.header("X-Lark-Signature") ?? "";
    if (signature) {
      const timestamp = c.req.header("X-Lark-Request-Timestamp") ?? "";
      const nonce = c.req.header("X-Lark-Request-Nonce") ?? "";
      if (!this.deps.feishuGateway.verifySignature(timestamp, nonce, body, signature)) {
        this.deps.logger.warn("Invalid Feishu webhook signature");
        return c.json({ error: "Invalid signature" }, 403);
      }
    }

    return null;
  }

  private async handleMessage(event: FeishuEvent): Promise<void> {
    const message = event.event!.message!;
    const sender = event.event!.sender!;

    if (message.message_type !== "text" || sender.sender_type === "app") {
      return;
    }

    try {
      const content = JSON.parse(message.content) as { text: string };

      await this.deps.messageProcessor.process({
        chatId: message.chat_id,
        text: content.text.trim(),
        senderId: sender.sender_id.open_id,
        messageId: message.message_id,
      });
    } catch (err) {
      this.deps.logger.error("Failed to process Feishu webhook message", err instanceof Error ? err : undefined, {
        messageId: message.message_id,
      });
    }
  }
}
