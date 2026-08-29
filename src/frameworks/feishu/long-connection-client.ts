import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { Logger } from "@usecases/ports/logger";
import type { FeishuLongConnectionGateway, FeishuLongConnectionMessage } from "@usecases/im/feishu-long-connection-gateway";
import type { FeishuAccessTokenManager } from "./access-token-manager";
import type { FeishuConfig } from "./types";

export type { FeishuConfig };

/** 多模态 Phase 2：非 text 消息类型的结构化载荷（content 原文 JSON 解析后透传）。
 *  image: { image_key }; file: { file_key, file_name }; post 富文本在 extractPostText 里降级。 */
export type FeishuMediaPayload =
  | { type: "image"; imageKey: string }
  | { type: "file"; fileKey: string; fileName: string };

interface FeishuEventData {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
}

export class FeishuLongConnectionClient implements FeishuLongConnectionGateway {
  private wsClient: WSClient;
  private eventDispatcher: EventDispatcher;
  private messageHandler: ((msg: FeishuLongConnectionMessage) => void) | null = null;

  constructor(
    private readonly config: FeishuConfig,
    private readonly logger: Logger,
    private readonly tokenManager: FeishuAccessTokenManager,
  ) {
    this.eventDispatcher = new EventDispatcher({
      encryptKey: config.encryptKey,
    });

    this.wsClient = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: 0,
      onReady: () => {
        this.logger.info("Feishu WSClient onReady callback fired");
        const status = this.wsClient.getConnectionStatus();
        this.logger.info("Feishu WSClient connection status", {
          state: status.state,
          lastConnectTime: status.lastConnectTime,
          reconnectAttempts: status.reconnectAttempts,
        });
      },
      onError: (err) => {
        this.logger.error("Feishu WSClient onError callback fired", err);
      },
      onReconnecting: () => {
        this.logger.warn("Feishu WSClient onReconnecting callback fired");
      },
      onReconnected: () => {
        this.logger.info("Feishu WSClient onReconnected callback fired");
      },
    });
  }

  /** 启动长连接 */
  async start(): Promise<void> {
    try {
      this.logger.info("Registering Feishu event handlers", {
        eventType: "im.message.receive_v1",
      });

      this.eventDispatcher.register({
        "im.message.receive_v1": (data) => {
          this.logger.info("Feishu event handler called", {
            eventId: data.event_id,
            eventType: data.event_type,
          });
          this.handleEvent(data);
        },
      });

      await this.wsClient.start({
        eventDispatcher: this.eventDispatcher,
      });

      const status = this.wsClient.getConnectionStatus();
      this.logger.info("Feishu long connection started", {
        connectionState: status.state,
        lastConnectTime: status.lastConnectTime,
        reconnectAttempts: status.reconnectAttempts,
      });
    } catch (err) {
      this.logger.error("Failed to start Feishu long connection", err instanceof Error ? err : undefined);
      throw err;
    }
  }

  /** 停止长连接 */
  async stop(): Promise<void> {
    this.wsClient.close();
    this.logger.info("Feishu long connection stopped");
  }

  /** 注册消息处理器 */
  onMessage(handler: (msg: FeishuLongConnectionMessage) => void): void {
    this.messageHandler = handler;
  }

  /** 处理飞书事件 */
  private handleEvent(data: FeishuEventData): void {
    this.logger.info("Feishu event received", {
      eventId: data.event_id,
      eventType: data.event_type,
      chatId: data.message?.chat_id,
      messageId: data.message?.message_id,
      messageType: data.message?.message_type,
      senderType: data.sender?.sender_type,
    });

    if (this.shouldIgnoreEvent(data)) {
      return;
    }

    this.processMessage(data.message, data.sender);
  }

  /** 多模态 Phase 2：放行 text/image/file；其余（audio/media/share_chat/sticker 等）忽略。
   *  兼容性存量约定保留：非 text 类型原来直接丢弃，本期只扩展这两类（飞书消息类型全集很大，
   *  逐类适配应在真实需求出现时做，避免为不存在的消息类型写无测试的解析分支）。 */
  private static readonly SUPPORTED_MESSAGE_TYPES = new Set(["text", "image", "file"]);

  private shouldIgnoreEvent(data: FeishuEventData): boolean {
    if (data.sender.sender_type === "app") {
      this.logger.debug("Ignoring bot message", { chatId: data.message.chat_id });
      return true;
    }

    if (!FeishuLongConnectionClient.SUPPORTED_MESSAGE_TYPES.has(data.message.message_type)) {
      this.logger.debug("Ignoring unsupported message type", {
        chatId: data.message.chat_id,
        messageType: data.message.message_type,
      });
      return true;
    }

    return false;
  }

  private processMessage(
    message: FeishuEventData["message"],
    sender: FeishuEventData["sender"],
  ): void {
    try {
      /** 多模态 Phase 2：image/file 提取结构化载荷；text 走原路径 */
      const media = this.extractMediaPayload(message.message_type, message.content);
      const content = JSON.parse(message.content) as { text?: string };
      const feishuMessage: FeishuLongConnectionMessage = {
        chatId: message.chat_id,
        messageId: message.message_id,
        text: content.text ?? "",
        senderId: sender.sender_id?.open_id ?? "unknown",
        senderType: sender.sender_type,
        messageType: message.message_type,
        ...(media && { media }),
      };

      this.logger.info("Feishu message parsed", {
        chatId: feishuMessage.chatId,
        messageId: feishuMessage.messageId,
        messageType: feishuMessage.messageType,
        textLength: feishuMessage.text.length,
        ...(media && { mediaType: media.type, mediaKey: media.type === "image" ? media.imageKey.slice(0, 16) : media.fileKey.slice(0, 16) }),
      });

      if (this.messageHandler) {
        Promise.resolve(this.messageHandler(feishuMessage)).catch((err) => {
          this.logger.error("Message handler error", err instanceof Error ? err : undefined, {
            chatId: feishuMessage.chatId,
            messageId: feishuMessage.messageId,
          });
        });
      } else {
        this.logger.warn("No message handler registered");
      }
    } catch (err) {
      this.logger.error("Failed to parse Feishu message content", err instanceof Error ? err : undefined, {
        rawContent: message.content,
      });
    }
  }

  /** 多模态 Phase 2：image/file content JSON → 结构化载荷；其余类型返回 null。
   *  解析失败（字段缺失/非 JSON）返回 null：调用方按无附件的纯文本消息降级处理。 */
  private extractMediaPayload(messageType: string, rawContent: string): FeishuMediaPayload | null {
    try {
      const parsed = JSON.parse(rawContent) as Record<string, unknown>;
      if (messageType === "image" && typeof parsed.image_key === "string") {
        return { type: "image", imageKey: parsed.image_key };
      }
      if (messageType === "file" && typeof parsed.file_key === "string") {
        return { type: "file", fileKey: parsed.file_key, fileName: typeof parsed.file_name === "string" ? parsed.file_name : "file" };
      }
      return null;
    } catch {
      return null;
    }
  }

}
