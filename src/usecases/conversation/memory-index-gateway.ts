/** Gateway: 记忆索引（由 main.ts 装配 StoreMemory 实现） */
export interface MemoryIndexGateway {
  /** 索引消息内容到记忆系统 */
  indexMessage(
    messageId: string,
    conversationId: string,
    content: string,
  ): Promise<void>;
  /** 索引链接资源到记忆系统（fact 类型索引 content，其他类型索引 url） */
  indexLinkedResource(
    resourceId: string,
    conversationId: string,
    content: string,
    resourceType?: string,
  ): Promise<void>;
  /** 索引 Feature 文档 summary 到记忆系统 */
  indexFeature(
    id: string,
    summary: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
  /** 索引 Research 文档 summary 到记忆系统 */
  indexResearch(
    id: string,
    summary: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
  /** F20260803fbit: 索引 Feature 文档正文（独立 entry，与 summary entry 并存） */
  indexFeatureBody(
    id: string,
    body: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
  /** F20260803fbit: 索引 Research 文档正文 */
  indexResearchBody(
    id: string,
    body: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
}
