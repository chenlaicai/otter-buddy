import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { Logger } from "@usecases/ports/logger";
import type { FeishuLongConnectionGateway, FeishuLongConnectionMessage, FeishuMediaPayload, FeishuPostMediaItem } from "@usecases/im/feishu-long-connection-gateway";
import type { FeishuAccessTokenManager } from "./access-token-manager";
import type { FeishuConfig } from "./types";
import type { ChannelStatusRegistry } from "@usecases/channel/channel-status";

export type { FeishuConfig };

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
    private readonly registry?: ChannelStatusRegistry,
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
        // 首次建连成功，上报 running 状态
        this.reportStatus("running");
      },
      onError: (err) => {
        this.logger.error("Feishu WSClient onError callback fired", err);
        // 上报 error_backoff 状态
        this.reportStatus("error_backoff", { errorMsg: err instanceof Error ? err.message : String(err) });
      },
      onReconnecting: () => {
        this.logger.warn("Feishu WSClient onReconnecting callback fired");
        // 上报 error_backoff 状态（WS 重连中）
        this.reportStatus("error_backoff", { errorMsg: "WS 重连中" });
      },
      onReconnected: () => {
        this.logger.info("Feishu WSClient onReconnected callback fired");
        // 断线重连成功，刷新 since
        this.reportStatus("running");
      },
    });
  }

  /** 上报通道状态到 registry（防御性调用：registry 可选注入） */
  private reportStatus(
    kind: "running" | "error_backoff",
    extra?: { errorMsg?: string },
  ): void {
    if (!this.registry) return;
    const channelId = "feishu";
    const now = Date.now();
    switch (kind) {
      case "running":
        this.registry.update(channelId, { kind: "feishu", state: { kind: "running", since: now } });
        break;
      case "error_backoff":
        this.registry.update(channelId, { kind: "feishu", state: { kind: "error_backoff", since: now, errorMsg: extra?.errorMsg || "" } });
        break;
    }
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

  /** 多模态 Phase 2：放行 text/image/file；F20260829fpst 增加 post 富文本混排。
   *  其余（audio/share_chat/sticker 等）仍忽略——飞书消息类型全集很大，
   *  逐类适配应在真实需求出现时做，避免为不存在的消息类型写无测试的解析分支。 */
  private static readonly SUPPORTED_MESSAGE_TYPES = new Set(["text", "image", "file", "post"]);

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
      /** 多模态 Phase 2：image/file 提取结构化载荷；F20260829fpst：post 段落解析；text 走原路径 */
      const media = this.extractMediaPayload(message.message_type, message.content);
      const content = JSON.parse(message.content) as { text?: string };
      const feishuMessage: FeishuLongConnectionMessage = {
        chatId: message.chat_id,
        messageId: message.message_id,
        // F20260829fpst：post 正文提取段落 text（非 post 类型维持 content.text 原路径）
        text: message.message_type === "post"
          ? this.extractPostText(content)
          : content.text ?? "",
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
        ...(media && this.mediaLogFields(media)),
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
   *  F20260829fpst：post 富文本混排——按段落顺序收集 img/media 段为媒体项列表；
   *  纯文本 post（无媒体段）返回 null，走原文本路径（不带 media 载荷）。
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
      if (messageType === "post") {
        const items = this.extractPostMediaItems(parsed);
        return items.length > 0 ? { type: "post", postItems: items } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** F20260829fpst：post content → 正文文本（text 段按段落/位置序拼接，段落间 \n\n）。
   *  与 extractPostMediaItems 同一套递归语言定位逻辑，保证 text 与媒体项的
   *  顺序口径一致（同一语言体内收集）。解析失败返回空串（消息仍处理，不丢）。 */
  private extractPostText(content: unknown): string {
    const body = this.locatePostBody(content);
    if (!body) return "";
    const paragraphs: string[] = [];
    for (const para of body) {
      if (!Array.isArray(para)) continue;
      const parts = para
        .map(seg => this.postSegmentText(seg))
        .filter(t => t !== "");
      if (parts.length > 0) paragraphs.push(parts.join(""));
    }
    return paragraphs.join("\n\n");
  }

  /** post 段 → 正文片段。text 段原样；a 段输出 Markdown 链接 [文字](href)
   *  （Web Markdown 流自动渲染可点击，LLM 可见 URL）；href 缺失或含空白
   *  （非法 URL 会让 Markdown 链接断裂）时降级只保留文字，不丢内容。 */
  private postSegmentText(seg: unknown): string {
    if (!this.isPostTextSegment(seg) || typeof seg.text !== "string") return "";
    if (seg.tag === "a" && typeof seg.href === "string" && seg.href !== "" && !/\s/.test(seg.href)) {
      return `[${seg.text}](${seg.href})`;
    }
    return seg.text;
  }

  /** F20260829fpst：post content → 按段落顺序的媒体项（img→image / media→file）。
   *  img 段 {tag:"img", image_key}；media 段 {tag:"media", file_key, file_name?}。
   *  a/at 段无媒体语义跳过；段缺失 key 跳过（不整条丢弃——其余段照常处理）。 */
  private extractPostMediaItems(content: unknown): FeishuPostMediaItem[] {
    const body = this.locatePostBody(content);
    if (!body) return [];
    const items: FeishuPostMediaItem[] = [];
    for (const para of body) {
      if (!Array.isArray(para)) continue;
      for (const seg of para) {
        if (!this.isPostTextSegment(seg) || typeof seg.tag !== "string") continue;
        if (seg.tag === "img" && typeof seg.image_key === "string") {
          items.push({ kind: "image", key: seg.image_key });
        } else if (seg.tag === "media" && typeof seg.file_key === "string") {
          items.push({ kind: "file", key: seg.file_key, fileName: typeof seg.file_name === "string" ? seg.file_name : undefined });
        }
      }
    }
    return items;
  }

  /** post 语言体定位：content.content.{lang} 每个语言体是 { title, content: 段落数组 }，
   *  取第一个可用语言体的段落数组（飞书文档推荐优先配置语言；新旧版事件
   *  均至少携带一个可用语言体，首个即可用）。 */
  private locatePostBody(content: unknown): unknown[] | null {
    if (typeof content !== "object" || content === null) return null;
    const raw = (content as { content?: unknown }).content;
    if (typeof raw !== "object" || raw === null) return null;
    for (const langBody of Object.values(raw)) {
      if (typeof langBody !== "object" || langBody === null) continue;
      const body = (langBody as { content?: unknown }).content;
      if (Array.isArray(body)) return body;
    }
    return null;
  }

  /** post 段的宽容类型判别（结构形状检查，避免 any） */
  private isPostTextSegment(seg: unknown): seg is Record<string, unknown> {
    return typeof seg === "object" && seg !== null;
  }

  /** 媒体日志字段（image/file 单媒体 vs post 媒体项列表） */
  private mediaLogFields(media: FeishuMediaPayload): Record<string, unknown> {
    if (media.type === "post") {
      return {
        mediaType: "post",
        postMediaCount: media.postItems?.length ?? 0,
        postMediaKinds: (media.postItems ?? []).map(i => i.kind).join(","),
      };
    }
    return {
      mediaType: media.type,
      mediaKey: media.type === "image" ? (media.imageKey ?? "").slice(0, 16) : (media.fileKey ?? "").slice(0, 16),
    };
  }
}
