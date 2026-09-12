import type { ManageConnection } from "@usecases/im/manage-connection";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { FeishuGateway } from "@usecases/im/feishu-gateway";
import type { Logger } from "@usecases/ports/logger";
import {
  parseCommand,
  formatConversationList,
  HELP_TEXT,
} from "@usecases/im/feishu-command-parser";

/** F20260910ctlv 批4a：entries 版历史格式化（与微信 formatEntryHistory 同构） */
function formatEntryHistory(entries: Array<{ senderType: string | null; body: string | null; createdAt: string }>): string {
  if (entries.length === 0) return "暂无历史消息";
  const lines = entries.map(e => {
    const sender = e.senderType === "user" ? "用户" : e.senderType === "otter" ? "水獭" : "系统";
    const time = new Date(e.createdAt).toLocaleString("zh-CN");
    return `[${time}] ${sender}: ${e.body || "(空消息)"}`;
  });
  return `最近消息:\n${lines.join("\n")}`;
}

export class CommandDispatcher {
  constructor(
    private readonly manageConnection: ManageConnection,
    /** F20260910ctlv 批4a：/history 切 entries（messages 停写，与微信同构） */
    private readonly entryRepo: EntryRepository,
    private readonly feishuGateway: FeishuGateway,
    private readonly logger: Logger,
  ) {}

  async dispatch(connectionId: string, text: string, chatId: string): Promise<void> {
    const parsed = parseCommand(text);
    this.logger.info("Dispatching command", { connectionId, chatId, command: parsed.command });
    await this.executeCommand(connectionId, parsed, chatId);
  }

  private async executeCommand(connectionId: string, parsed: ReturnType<typeof parseCommand>, chatId: string): Promise<void> {
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
          await this.feishuGateway.replyText(chatId, `进入对话失败: ${err instanceof Error ? err.message : "Unknown error"}`);
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
        // F20260910ctlv 批4a：/history 切 entries（speak+user 合并按 seq 倒取 20 条）
        const [speaks, users] = await Promise.all([
          this.entryRepo.getEntries(conversation.id, { entryType: "speak", limit: 20 }),
          this.entryRepo.getEntries(conversation.id, { entryType: "user", limit: 20 }),
        ]);
        const recent = [...speaks, ...users]
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .slice(0, 20)
          .reverse();
        await this.feishuGateway.replyText(chatId, formatEntryHistory(recent));
        break;
      }
      case "help": {
        await this.feishuGateway.replyText(chatId, HELP_TEXT);
        break;
      }
      case "unknown": {
        await this.feishuGateway.replyText(chatId, `未知命令: ${parsed.raw}\n\n${HELP_TEXT}`);
        break;
      }
    }
  }
}
