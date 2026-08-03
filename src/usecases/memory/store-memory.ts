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
  /** F20260803fbit: bge-m3 8192 tokens 上限的 ~75%，中英文混合留余量 */
  private static readonly EMBED_MAX_CHARS = 6000;

  constructor(
    private readonly repo: MemoryRepository,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly logger: Logger,
  ) {}

  /** F20260803fbit: 截断 content 防 embedding worker OOM。FTS 灌全量不受影响 */
  private truncateForEmbed(content: string): string {
    return content.length > StoreMemory.EMBED_MAX_CHARS
      ? content.slice(0, StoreMemory.EMBED_MAX_CHARS)
      : content;
  }

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
     *  D22 降级：嵌入失败时该条目仅可通过 FTS5 检索，不阻塞
     *  F20260803fbit: 截断防超长 body OOM worker */
    this.embeddingGateway
      .embed(this.truncateForEmbed(input.content))
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

  /**
   * F20260803mval: 按 source 原子替换（单事务内删旧+插新），用于文档 upsert reindex。
   * 防 B2 非原子问题：原 deleteBySource + execute 两事务，中间失败会丢 memory entry。
   */
  async replaceBySource(input: MemoryEntryInput): Promise<string> {
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

    await this.repo.replaceEntryBySource(entry);

    // F20260803fbit: 截断防超长 body OOM worker（与 execute 路径对称）
    this.embeddingGateway
      .embed(this.truncateForEmbed(input.content))
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

  /**
   * F20260803chunk: 按 source 原子替换多条 entry（1:N），用于文档 chunk 索引 reindex。
   * 删旧全部 chunk + 插新 N 个 chunk（单事务）。每 chunk 独立 fire-and-forget embedding。
   * M16: N 个 chunk embedding 串行排队 bge-m3 worker，首次部署 ~546 embedding 约 27s，
   *      期间实时搜索的 query embedding 会排队（FTS 不受影响）。批量接口/优先级队列见 follow-up。
   */
  async replaceChunksBySource(inputs: MemoryEntryInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const now = new Date().toISOString();
    const entries = inputs.map((input) => ({
      id: crypto.randomUUID(),
      layer: input.layer,
      contentType: input.contentType,
      sourceId: input.sourceId,
      sourceTable: input.sourceTable,
      conversationId: input.conversationId ?? null,
      granularity: input.granularity,
      content: input.content,
      metadata: input.metadata ?? null,
      createdAt: now,
    }));

    await this.repo.replaceEntriesBySource(entries);

    // 异步 fire-and-forget embedding（每 chunk 独立，chunk 长度可控 truncateForEmbed 几乎不触发）
    for (const entry of entries) {
      this.embeddingGateway
        .embed(this.truncateForEmbed(entry.content))
        .then((emb) => {
          this.repo.storeEmbedding(entry.id, emb).catch((err) => {
            this.logger.warn(`Failed to store embedding for ${entry.id}: ${err}`);
          });
        })
        .catch((err) => {
          this.logger.debug(`Embedding generation failed for ${entry.id}: ${err}`);
        });
    }

    return entries.map((e) => e.id);
  }
}
