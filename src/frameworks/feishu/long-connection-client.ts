import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { Logger } from "@usecases/ports/logger";
import type { FeishuLongConnectionGateway, FeishuLongConnectionMessage } from "@usecases/im/feishu-long-connection-gateway";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
}

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
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly config: FeishuConfig,
    private readonly logger: Logger,
  ) {
    this.eventDispatcher = new EventDispatcher({
      verificationToken: config.verificationToken,
      encryptKey: config.encryptKey,
    });

    this.wsClient = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: 0, // debug level for more verbose logging
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
      // 注册消息处理器
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

      // 检查连接状态
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

  private shouldIgnoreEvent(data: FeishuEventData): boolean {
    if (data.sender.sender_type === "app") {
      this.logger.debug("Ignoring bot message", { chatId: data.message.chat_id });
      return true;
    }

    if (data.message.message_type !== "text") {
      this.logger.debug("Ignoring non-text message", {
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
      const content = JSON.parse(message.content) as { text: string };
      const feishuMessage: FeishuLongConnectionMessage = {
        chatId: message.chat_id,
        messageId: message.message_id,
        text: content.text,
        senderId: sender.sender_id?.open_id ?? "unknown",
        senderType: sender.sender_type,
        messageType: message.message_type,
      };

      this.logger.info("Feishu message parsed", {
        chatId: feishuMessage.chatId,
        messageId: feishuMessage.messageId,
        textLength: feishuMessage.text.length,
        textPreview: feishuMessage.text.substring(0, 50),
      });

      if (this.messageHandler) {
        this.messageHandler(feishuMessage);
      } else {
        this.logger.warn("No message handler registered");
      }
    } catch (err) {
      this.logger.error("Failed to parse Feishu message content", err instanceof Error ? err : undefined, {
        rawContent: message.content,
      });
    }
  }

  /** 获取 tenant_access_token（自动缓存，过期前刷新，并发安全） */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefreshToken();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefreshToken(): Promise<string> {
    const response = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );

    const data = (await response.json()) as {
      code: number;
      msg: string;
      tenant_access_token: string;
      expire: number;
    };

    if (data.code !== 0) {
      throw new Error(`Failed to get access token: ${data.msg}`);
    }

    this.accessToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (data.expire - 300) * 1000;

    this.logger.info("Feishu access token refreshed", {
      expiresIn: data.expire,
    });

    return this.accessToken;
  }

  /** 发送文本消息到群 */
  async sendText(chatId: string, text: string): Promise<string> {
    const token = await this.getAccessToken();

    const response = await fetch(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      },
    );

    const data = (await response.json()) as {
      code: number;
      msg: string;
      data: { message_id: string };
    };

    if (data.code !== 0) {
      this.logger.error("Failed to send Feishu message", undefined, {
        chatId,
        code: data.code,
        msg: data.msg,
      });
      throw new Error(`Failed to send message: ${data.msg}`);
    }

    this.logger.info("Feishu message sent", { chatId, textLength: text.length });
    return data.data.message_id;
  }

  /** 更新消息（用于流式响应） */
  async patchText(messageId: string, text: string): Promise<void> {
    const token = await this.getAccessToken();

    await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });
  }
}
