import type { FeishuLongConnectionGateway, FeishuLongConnectionMessage } from "@usecases/im/feishu-long-connection-gateway";
import type { FeishuMessageProcessor } from "./message-processor";
import type { Logger } from "@usecases/ports/logger";

export class FeishuLongConnectionHandler {
  constructor(
    private readonly deps: {
      longConnectionGateway: FeishuLongConnectionGateway;
      messageProcessor: FeishuMessageProcessor;
      logger: Logger;
    },
  ) {}

  /** 启动长连接 */
  async start(): Promise<void> {
    // 注册消息处理器
    this.deps.longConnectionGateway.onMessage((msg) => {
      this.handleMessage(msg);
    });

    // 启动长连接
    await this.deps.longConnectionGateway.start();
  }

  /** 停止长连接 */
  async stop(): Promise<void> {
    await this.deps.longConnectionGateway.stop();
  }

  private async handleMessage(msg: FeishuLongConnectionMessage): Promise<void> {
    try {
      await this.deps.messageProcessor.process({
        chatId: msg.chatId,
        text: msg.text,
        senderId: msg.senderId,
        messageId: msg.messageId,
      });
    } catch (err) {
      this.deps.logger.error("Failed to handle Feishu message", err instanceof Error ? err : undefined, {
        chatId: msg.chatId,
        messageId: msg.messageId,
      });
    }
  }
}
