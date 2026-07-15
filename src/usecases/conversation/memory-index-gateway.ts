/** Gateway: 记忆索引（由 main.ts 装配 StoreMemory 实现） */
export interface MemoryIndexGateway {
  /** 索引消息内容到记忆系统 */
  indexMessage(
    messageId: string,
    conversationId: string,
    content: string,
  ): Promise<void>;
  /** 索引关键事实到记忆系统 */
  indexKeyFact(
    keyFactId: string,
    conversationId: string,
    content: string,
  ): Promise<void>;
  /** 索引链接资源到记忆系统 */
  indexLinkedResource(
    resourceId: string,
    conversationId: string,
    url: string,
  ): Promise<void>;
}
