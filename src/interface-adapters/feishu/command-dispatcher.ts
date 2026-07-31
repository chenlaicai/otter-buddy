import type { ManageConnection } from "@usecases/im/manage-connection";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { Logger } from "@usecases/ports/logger";
import {
  parseCommand,
  formatConversationList,
  formatMessageHistory,
  HELP_TEXT,
} from "@usecases/im/feishu-command-parser";

export class CommandDispatcher {
  constructor(
    private readonly manageConnection: ManageConnection,
    private readonly queryMessage: QueryMessage,
    private readonly feishuGateway: FeishuGateway,
    private readonly logger: Logger,
  ) {}

  async dispatch(connectionId: string, text: string, chatId: string): Promise<void> {
    const parsed = parseCommand(text);

    this.logger.info("Dispatching command", {
      connectionId,
      chatId,
      command: parsed.command,
    });

    switch (parsed.command) {
      case "list": {
        const conversations = await this.manageConnection.listActiveConversations();
        await this.feishuGateway.replyText(chatId, formatConversationList(conversations));
        break;
      }

      case "in": {
        try {
          await this.manageConnection.enterConversation(connectionId, parsed.conversationId);
          await this.feishuGateway.replyText(chatId, `已进入对话: ${parsed.conversationId}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          await this.feishuGateway.replyText(chatId, `进入对话失败: ${message}`);
        }
        break;
      }

      case "out": {
        await this.manageConnection.leaveConversation(connectionId);
        await this.feishuGateway.replyText(chatId, "已退出当前对话");
        break;
      }

      case "history": {
        const conversation = await this.manageConnection.getCurrentConversation(connectionId);
        if (!conversation) {
          await this.feishuGateway.replyText(chatId, "当前未进入任何对话，请先使用 /in <对话ID> 进入对话");
          return;
        }

        const messages = await this.queryMessage.getMessages(conversation.id, { limit: 20 });
        await this.feishuGateway.replyText(chatId, formatMessageHistory(messages));
        break;
      }

      case "help": {
        await this.feishuGateway.replyText(chatId, HELP_TEXT);
        break;
      }

      case "unknown": {
        await this.feishuGateway.replyText(
          chatId,
          `未知命令: ${parsed.raw}\n\n${HELP_TEXT}`
        );
        break;
      }
    }
  }
}
