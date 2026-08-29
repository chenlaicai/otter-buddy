import type { Logger } from "@usecases/ports/logger";
import type { WeixinGateway } from "@usecases/im/weixin-gateway";
// eslint-disable-next-line no-restricted-imports -- 依赖注入与飞书同构：接口定义在 usecases port（WeixinGateway），实现需要的协议类型从 frameworks 引入
import type { WeixinApiClient } from "@frameworks/weixin/api-client";
// eslint-disable-next-line no-restricted-imports -- 同上：adapter 本就是 port 的 interface-adapters 实现，需要 account-store 的 context_token 回填
import type { WeixinAccountStore } from "@frameworks/weixin/account-store";

/**
 * 微信出站网关（interface-adapters 层，实现 usecases 的 WeixinGateway port）。
 *
 * 出站需要 context_token（入站消息携带、有时效的服务端会话凭证）——从
 * AccountStore 的映射表回填；查不到时降级裸发（协议允许，微信侧表现为
 * 可能收不到，记 warn 提示需等用户先发消息）。
 */
export class WeixinGatewayAdapter implements WeixinGateway {
  constructor(
    private readonly deps: {
      api: WeixinApiClient;
      accountStore: WeixinAccountStore;
      accountId: string;
      logger: Logger;
    },
  ) {}

  private resolveContextToken(toUserId: string): string | undefined {
    return this.deps.accountStore.loadContextTokens(this.deps.accountId)[toUserId];
  }

  async replyText(toUserId: string, text: string): Promise<void> {
    const contextToken = this.resolveContextToken(toUserId);
    if (!contextToken) {
      this.deps.logger.warn("Weixin reply without context_token (对方需先发一条消息建立会话)", { toUserId });
    }
    await this.deps.api.sendTextMessage({ toUserId, contextToken, text });
  }

  /**
   * 微信协议仅支持纯文本（item type=1）。markdown 投影已在 usecases 层的
   * projectForChannel 完成（html-card → 占位符 + Web 链接），这里补一道
   * 轻量 markdown 语法降噪（去井号/星号/反引号等标记字符），保内容不保格式。
   * senderLabel 拼前缀（微信无私聊 bot 名展示位）。
   */
  async replyMarkdown(toUserId: string, senderLabel: string, markdown: string): Promise<void> {
    const text = `[${senderLabel}] ${WeixinGatewayAdapter.markdownToPlain(markdown)}`;
    await this.replyText(toUserId, text);
  }

  /** markdown 语法字符降噪（标题/强调/代码/链接→文本）。尽力而为，不追求完美 */
  static markdownToPlain(md: string): string {
    return md
      // 链接 [text](url) → text（url 对纯文本用户是噪音）
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
      // 加粗/斜体
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      // 行内代码与代码围栏标记
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^```[^\n]*$/gm, "")
      // 标题井号
      .replace(/^#{1,6}\s+/gm, "")
      // 引用块标记
      .replace(/^>\s?/gm, "")
      // 无序列表标记（保缩进层级感）
      .replace(/^(\s*)[-*]\s+/gm, "$1• ")
      // 连续空行压一行
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
