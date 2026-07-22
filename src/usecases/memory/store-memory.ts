import type {
  MemoryLayer,
  MemoryContentType,
  RetrievalGranularity,
} from "@entities/memory/memory-entry";
import type { MemoryRepository } from "./memory-repository";
import type { EmbeddingGateway } from "./embedding-gateway";
import type { Logger } from "@usecases/ports/logger";

export interface MemoryEntryInput {
  layer: MemoryLayer;
  contentType: MemoryContentType;
  sourceId: string;
  sourceTable: string;
  conversationId?: string;
  granularity: RetrievalGranularity;
  content: string;
  metadata?: Record<string, unknown>;
}

export class StoreMemory {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly logger: Logger,
  ) {}

  async execute(input: MemoryEntryInput): Promise<string> {
    const id = crypto.randomUUID();

    const entry = {
      id,
      layer: input.layer,
      contentType: input.contentType,
      sourceId: input.sourceId,
      sourceTable: input.sourceTable,
      conversationId: input.conversationId ?? null,
      granularity: input.granularity,
      content: input.content,
      metadata: input.metadata ?? null,
      createdAt: new Date().toISOString(),
    };

    /** 同步事务：entries + fts + weights */
    await this.repo.storeEntry(entry);

    /** 异步 fire-and-forget embedding（D27: 不阻塞返回）
     *  D22 降级：嵌入失败时该条目仅可通过 FTS5 检索，不阻塞 */
    this.embeddingGateway
      .embed(input.content)
      .then((emb) => {
        this.repo.storeEmbedding(id, emb).catch((err) => {
          this.logger.warn(`Failed to store embedding for ${id}: ${err}`);
        });
      })
      .catch((err) => {
        this.logger.debug(`Embedding generation failed for ${id}: ${err}`);
      });

    return id;
  }
}
