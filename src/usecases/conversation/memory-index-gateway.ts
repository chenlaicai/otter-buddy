/** F20260803chunk: 分段后的 chunk 数据（原始 markdown，未清理） */
export interface ChunkData {
  /** 原始 markdown 内容（含标题井号，清理在索引时做） */
  content: string;
  /** 标题路径，如 ["背景", "问题"] */
  headingPath: string[];
  /** 原始 markdown 字符数 */
  charCount: number;
}

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
  /** F20260803chunk: 索引 Feature 文档分段 chunks（N 个独立 entry，原子替换旧 chunks） */
  indexFeatureChunks(
    id: string,
    chunks: ChunkData[],
    metadata: Record<string, unknown>,
  ): Promise<void>;
  /** F20260803chunk: 索引 Research 文档分段 chunks */
  indexResearchChunks(
    id: string,
    chunks: ChunkData[],
    metadata: Record<string, unknown>,
  ): Promise<void>;
}
