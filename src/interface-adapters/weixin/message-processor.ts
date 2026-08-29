import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { WeixinGateway } from "@usecases/im/weixin-gateway";
import type { PartnerResolver } from "@usecases/im/partner-resolver";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { Logger } from "@usecases/ports/logger";
import { parseCommand, formatConversationList, formatMessageHistory, HELP_TEXT } from "@usecases/im/feishu-command-parser";

/** 命令处理结果：回复文本（各命令产出，统一由外层回发） */
type CommandReply = string;

/**
 * 微信入站消息处理器（interface-adapters 层，照 FeishuMessageProcessor 模式）。
 *
 * 命令体系复用 feishu-command-parser（/list /in /out /history /help 与
 * ManageConnection 的会话绑定语义通道无关）；partnerResolver 做命令门禁
 * （F20260826fpbd 方案 B 同语义：配置 partnerUserId 时仅搭档可用命令）。
 */
export class WeixinMessageProcessor {
  constructor(
    private readonly deps: {
      manageConnection: ManageConnection;
      sendMessage: SendMessage;
      queryMessage: QueryMessage;
      weixinGateway: WeixinGateway;
      partnerResolver?: PartnerResolver;
      agentDispatchService: AgentDispatchService;
      messageBroadcaster: MessageBroadcaster;
      logger: Logger;
    },
  ) {}

  async process(msg: { fromUserId: string; body: string; messageId?: string }): Promise<void> {
    const { fromUserId, body } = msg;

    this.deps.logger.info("Processing Weixin message", {
      fromUserId,
      messageId: msg.messageId,
      textLength: body.length,
    });

    const connection = await this.deps.manageConnection.ensureConnection(fromUserId, fromUserId);

    // 命令分支（与飞书同门禁语义：未配置 partnerUserId 不拦，配置后仅搭档可用）
    if (body.startsWith("/")) {
      await this.dispatchCommand(fromUserId, connection.id, body);
      return;
    }

    // 空文本（纯媒体消息，PR③ 扩展）占位防空
    const bodyText = body.trim() ? body : "[媒体消息（当前版本暂不支持，敬请期待图片/语音支持）]";

    const conversation = await this.deps.manageConnection.getCurrentConversation(connection.id);
    if (!conversation) {
      await this.deps.weixinGateway.replyText(
        fromUserId,
        "当前未进入任何对话，请先使用 /in <对话ID> 进入对话\n\n使用 /list 查看可用对话",
      );
      return;
    }

    const { message } = await this.deps.sendMessage.send({
      conversationId: conversation.id,
      senderId: fromUserId,
      senderType: "user",
      talkingStonePassedTo: [],
      body: bodyText,
      source: "weixin",
    });

    // 广播到 Web 端（实时同步；微信侧发送者自己可见，无需回投）
    this.deps.messageBroadcaster.broadcast(message).catch((err) => {
      this.deps.logger.error("Failed to broadcast weixin message", err instanceof Error ? err : undefined, {
        conversationId: conversation.id,
        messageId: message.id,
      });
    });

    // 异步触发 Agent 派发
    await this.dispatchAgent(conversation.id, bodyText, fromUserId);
  }

  /** 命令分支：门禁 + 分发（命令集与飞书完全一致），每命令返回回复文本统一回发 */
  private async dispatchCommand(fromUserId: string, connectionId: string, text: string): Promise<void> {
    if (this.deps.partnerResolver?.configured && !this.deps.partnerResolver.isPartner(fromUserId)) {
      await this.deps.weixinGateway.replyText(fromUserId, "这些命令暂时不对所有人开放哦～直接聊天就行 🦦");
      return;
    }
    const reply = await this.executeCommand(connectionId, parseCommand(text));
    await this.deps.weixinGateway.replyText(fromUserId, reply);
  }

  private async executeCommand(connectionId: string, parsed: ReturnType<typeof parseCommand>): Promise<CommandReply> {
    switch (parsed.command) {
      case "list": {
        const conversations = await this.deps.manageConnection.listActiveConversations();
        return formatConversationList(conversations);
      }
      case "in": {
        try {
          await this.deps.manageConnection.enterConversation(connectionId, parsed.conversationId!);
          return `已进入对话: ${parsed.conversationId}`;
        } catch (err) {
          return `进入对话失败: ${err instanceof Error ? err.message : "Unknown error"}`;
        }
      }
      case "out": {
        await this.deps.manageConnection.leaveConversation(connectionId);
        return "已退出当前对话";
      }
      case "history": {
        const conversation = await this.deps.manageConnection.getCurrentConversation(connectionId);
        if (!conversation) {
          return "当前未进入任何对话，请先使用 /in <对话ID> 进入对话";
        }
        const messages = await this.deps.queryMessage.getMessages(conversation.id, { limit: 20 });
        return formatMessageHistory(messages);
      }
      case "help":
        return HELP_TEXT;
      case "unknown":
        return `未知命令: ${parsed.raw}\n\n${HELP_TEXT}`;
    }
  }

  private async dispatchAgent(conversationId: string, bodyText: string, senderId: string): Promise<void> {
    const result = await this.deps.agentDispatchService.dispatch(conversationId, bodyText, senderId);
    if (result.error) {
      this.deps.logger.error("Weixin agent dispatch failed", undefined, { conversationId, error: result.error });
    }
  }
}
