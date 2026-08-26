import type { ManageConnection } from "@usecases/im/manage-connection";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { CommandDispatcher } from "./command-dispatcher";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { FeishuUserInfoGateway } from "@usecases/im/feishu-user-info-gateway";
import type { PartnerResolver } from "@usecases/im/partner-resolver";
import type { AgentDispatchService } from "@usecases/conversation/agent-dispatch-service";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import type { Logger } from "@usecases/ports/logger";

export interface FeishuIncomingMessage {
  chatId: string;
  text: string;
  senderId: string;
  messageId: string;
}

export class FeishuMessageProcessor {
  constructor(
    private readonly deps: {
      manageConnection: ManageConnection;
      sendMessage: SendMessage;
      commandDispatcher: CommandDispatcher;
      feishuGateway: FeishuGateway;
      /** F20260826fuid：可选注入。未注入或解析失败时 senderName 快照为空，不影响主链路 */
      feishuUserInfo?: FeishuUserInfoGateway;
      /** F20260826fpbd：可选注入。命令门禁（方案B）；未注入或未配置时不拦 */
      partnerResolver?: PartnerResolver;
      agentDispatchService: AgentDispatchService;
      messageBroadcaster: MessageBroadcaster;
      logger: Logger;
    },
  ) {}

  async process(msg: FeishuIncomingMessage): Promise<void> {
    const { chatId, text, senderId, messageId } = msg;

    this.deps.logger.info("Processing Feishu message", {
      chatId,
      messageId,
      textLength: text.length,
    });

    const connection = await this.deps.manageConnection.ensureConnection(chatId, chatId);

    // 判断是否是命令
    if (text.startsWith("/")) {
      // F20260826fpbd（方案B）：会话管理命令仅搭档可用。拦截在消息入口而非 CommandDispatcher——
      // 命令分发器保持无身份概念，权限判定集中在 PartnerResolver 消费点；
      // 未配置 partnerOpenId 时不拦（降级，存量实例无感升级）
      if (this.deps.partnerResolver?.configured && !this.deps.partnerResolver.isPartner(senderId)) {
        await this.deps.feishuGateway.replyText(
          chatId,
          "这些命令暂时不对所有人开放哦～直接聊天就行 🦦",
        );
        return;
      }
      await this.deps.commandDispatcher.dispatch(connection.id, text, chatId);
      return;
    }

    // 普通消息：发送到当前绑定的 Conversation
    const conversation = await this.deps.manageConnection.getCurrentConversation(connection.id);
    if (!conversation) {
      await this.deps.feishuGateway.replyText(
        chatId,
        "当前未进入任何对话，请先使用 /in <对话ID> 进入对话\n\n使用 /list 查看可用对话"
      );
      return;
    }

    // 存消息（F20260826fuid：飞书消息带 senderDisplayName 快照，群聊多人可识别）
    const senderDisplayName = await this.resolveSenderName(senderId);
    const { message, mentionFeedback } = await this.deps.sendMessage.send({
      conversationId: conversation.id,
      senderId,
      senderType: "user",
      talkingStonePassedTo: [],
      body: text,
      source: "feishu",
      senderDisplayName,
    });

    this.deps.logger.info("Message saved to conversation", {
      connectionId: connection.id,
      conversationId: conversation.id,
      messageId: message.id,
    });

    // F20260820i333: @提及解析失败时发送 feedback 给用户
    if (mentionFeedback) {
      await this.deps.feishuGateway.replyText(chatId, mentionFeedback).catch(err => {
        this.deps.logger.error("Failed to send mention feedback", err instanceof Error ? err : undefined, {
          conversationId: conversation.id,
        });
      });
    }

    // 广播飞书消息到 Web 端（实时同步）
    this.deps.messageBroadcaster.broadcast(message).catch(err => {
      this.deps.logger.error("Failed to broadcast feishu message", err instanceof Error ? err : undefined, {
        conversationId: conversation.id,
        messageId: message.id,
      });
    });

    // 异步触发 Agent 派发
    this.triggerAgentDispatch(conversation.id, text, senderId);
  }

  /** F20260826fuid：open_id → 姓名。网关未注入/解析失败返回 null，永不阻塞消息入库 */
  private async resolveSenderName(senderId: string): Promise<string | null> {
    if (!this.deps.feishuUserInfo) return null;
    try {
      return await this.deps.feishuUserInfo.getUserName(senderId);
    } catch {
      return null;
    }
  }

  private triggerAgentDispatch(
    conversationId: string,
    userMessageContent: string,
    senderId: string,
  ): void {
    // 异步执行，不阻塞消息处理
    // Agent 事件通过 AgentInvoker.broadcastEvent 统一推送给所有订阅者
    // Agent 完成消息通过 AgentInvoker.broadcast 统一推送到外部渠道
    this.deps.agentDispatchService.dispatch(
      conversationId,
      userMessageContent,
      senderId,
    ).then(result => {
      if (result.error) {
        this.deps.logger.error("Agent dispatch failed", undefined, {
          conversationId,
          error: result.error,
        });
      }
    }).catch(err => {
      this.deps.logger.error("Agent dispatch exception", err instanceof Error ? err : undefined, {
        conversationId,
      });
    });
  }
}
