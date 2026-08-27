import type {
  MemoryLayer,
  MemoryContentType,
  RetrievalGranularity,
} from "@entities/memory/memory-entry";
import type { MemoryWriter } from "./memory-writer";
import type { MemoryQueue } from "./memory-queue";
import type { EmbeddingGateway } from "./embedding-gateway";
import type { Logger } from "@usecases/ports/logger";
import { redactSecrets, redactMetadataSecrets } from "@usecases/security/redact-secrets";

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

/** #509: 污染判定的 trim 阈值（<10 字符的 chunk 无检索价值，写入即污染） */
const MIN_VALID_CONTENT_CHARS = 10;

/** #509: trim 后内容低于阈值时拒绝入库（空/超短 content 占召回坑位，稀释信噪比） */
export class PollutedContentError extends Error {
  constructor(content: string) {
    super(
      `Refusing to store polluted memory entry: trimmed content length ${content.trim().length} < ${MIN_VALID_CONTENT_CHARS}`,
    );
    this.name = "PollutedContentError";
  }
}

export class StoreMemory {
  /** F20260803fbit: bge-m3 8192 tokens 上限的 ~75%，中英文混合留余量 */
  private static readonly EMBED_MAX_CHARS = 6000;

  constructor(
    private readonly writer: MemoryWriter,
    private readonly queue: MemoryQueue,
    private readonly embeddingGateway: EmbeddingGateway,
    private readonly logger: Logger,
  ) {}

  /** F20260803fbit: 截断 content 防 embedding worker OOM。FTS 灌全量不受影响 */
  private truncateForEmbed(content: string): string {
    return content.length > StoreMemory.EMBED_MAX_CHARS
      ? content.slice(0, StoreMemory.EMBED_MAX_CHARS)
      : content;
  }

  async execute(rawInput: MemoryEntryInput): Promise<string> {
    const input = this.redactInput(rawInput);
    this.assertValidContent(input);
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
    await this.writer.storeEntry(entry);

    /** 异步 fire-and-forget embedding（D27: 不阻塞返回）
     *  D22 降级：嵌入失败时该条目仅可通过 FTS5 检索，不阻塞
     *  F20260803fbit: 截断防超长 body OOM worker
     *  F20260812mrcq Part 1：失败入 embedding_tasks 队列，retry worker 兜底 */
    this.fireAndForgetEmbed(id, input.content);

    return id;
  }

  /**
   * F20260812mrcq Part 1：fire-and-forget embedding 的统一封装。
   * embed 成功 → storeEmbedding；任一失败 → enqueueRetry 入队（ON CONFLICT 保留 attempts）。
   * 三处调用点（execute / replaceBySource / replaceChunksBySource）共用，避免重复。
   */
  private fireAndForgetEmbed(entryId: string, content: string): void {
    this.embeddingGateway
      .embed(this.truncateForEmbed(content))
      .then((emb) => {
        this.writer.storeEmbedding(entryId, emb).catch((err) => {
          this.logger.warn(`Failed to store embedding for ${entryId}: ${err}`);
          this.queue.enqueueRetry(entryId, err).catch(e =>
            this.logger.error(`enqueueRetry failed for ${entryId}: ${e}`),
          );
        });
      })
      .catch((err) => {
        this.logger.debug(`Embedding generation failed for ${entryId}: ${err}`);
        this.queue.enqueueRetry(entryId, err).catch(e =>
          this.logger.error(`enqueueRetry failed for ${entryId}: ${e}`),
        );
      });
  }

  /**
   * F20260803mval: 按 source 原子替换（单事务内删旧+插新），用于文档 upsert reindex。
   * 防 B2 非原子问题：原 deleteBySource + execute 两事务，中间失败会丢 memory entry。
   */
  async replaceBySource(rawInput: MemoryEntryInput): Promise<string> {
    const input = this.redactInput(rawInput);
    this.assertValidContent(input);
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

    await this.writer.replaceEntryBySource(entry);

    // F20260803fbit + F20260812mrcq Part 1：截断防超长 body OOM worker；失败入队
    this.fireAndForgetEmbed(id, input.content);

    return id;
  }

  /**
   * F20260803chunk: 按 source 原子替换多条 entry（1:N），用于文档 chunk 索引 reindex。
   * 删旧全部 chunk + 插新 N 个 chunk（单事务）。每 chunk 独立 fire-and-forget embedding。
   * M16: N 个 chunk embedding 串行排队 bge-m3 worker，首次部署 ~546 embedding 约 27s，
   *      期间实时搜索的 query embedding 会排队（FTS 不受影响）。批量接口/优先级队列见 follow-up。
   */
  async replaceChunksBySource(rawInputs: MemoryEntryInput[]): Promise<string[]> {
    if (rawInputs.length === 0) return [];
    const inputs = rawInputs.map((raw) => this.redactInput(raw));
    // #509: 逐条过滤污染 chunk（拒绝而非降级入库）——batch 内部分污染不拖累健康 chunk，但调用方需感知
    const validInputs = inputs.filter((input) => {
      if (input.content.trim().length < MIN_VALID_CONTENT_CHARS) {
        this.logger.warn(
          `Dropping polluted chunk (${input.sourceTable}/${input.sourceId}, contentType=${input.contentType}): trimmed length ${input.content.trim().length} < ${MIN_VALID_CONTENT_CHARS}`,
          { action: "polluted_chunk_dropped" },
        );
        return false;
      }
      // #509: 一致性告警——metadata.char_count（raw markdown）与实际入库 content（cleaned 后）显著偏离时告警
      // 历史缺陷（833391fa：char_count=933 但 content=`2.`）表明提取层可能截断，此处兜底感知
      const charCount = input.metadata?.char_count;
      if (
        typeof charCount === "number" &&
        charCount > MIN_VALID_CONTENT_CHARS &&
        input.content.trim().length < charCount * 0.2
      ) {
        this.logger.warn(
          `Chunk char_count mismatch (${input.sourceTable}/${input.sourceId}): metadata char_count=${charCount} but cleaned content length=${input.content.trim().length}`,
          { action: "chunk_char_count_mismatch" },
        );
      }
      return true;
    });
    if (validInputs.length === 0) return [];
    const now = new Date().toISOString();
    const entries = validInputs.map((input) => ({
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

    await this.writer.replaceEntriesBySource(entries);

    // 异步 fire-and-forget embedding（每 chunk 独立，chunk 长度可控 truncateForEmbed 几乎不触发）
    for (const entry of entries) {
      this.fireAndForgetEmbed(entry.id, entry.content);
    }

    return entries.map((e) => e.id);
  }

  /**
   * F20260821scrt: 写入前 secrets 脱敏（content + metadata 字符串值）。
   * 所有记忆持久化（消息投影/fact/文档 summary+chunks）必经此三入口，
   * DB 双写表（entries/fts）与 embedding 拿到的均为脱敏后内容。
   * 命中时 warn 只记录来源定位，不记录原文。
   */
  private redactInput(input: MemoryEntryInput): MemoryEntryInput {
    const content = redactSecrets(input.content);
    const metadata = input.metadata
      ? redactMetadataSecrets(input.metadata)
      : input.metadata;
    if (content !== input.content || metadata !== input.metadata) {
      this.logger.warn(
        `Secrets redacted before storing memory entry (${input.sourceTable}/${input.sourceId}, contentType=${input.contentType})`,
      );
    }
    return metadata === input.metadata
      ? { ...input, content }
      : { ...input, content, metadata };
  }

  /** PR审视 S3-14: 按 source + contentType 删除 chunk entries（body 清空时清理旧 chunk） */
  async deleteChunksBySource(sourceTable: string, sourceId: string, contentType: MemoryContentType): Promise<void> {
    await this.writer.deleteBySourceAndType(sourceTable, sourceId, contentType);
  }

  /** #509: 入库前 content 有效性拦截——trim 后空 content 无检索价值，写入即污染。
   *  阈值只拦“空”（0 字符）：短消息（如“继续”）是合法内容，不可误伤；
   *  超短阈值（<10）拦截只在 chunk 批量路径（replaceChunksBySource）生效——
   *  文档段落 <10 字符无检索价值，但消息/fact 类不适用。 */
  private assertValidContent(input: MemoryEntryInput): void {
    if (input.content.trim().length === 0) {
      throw new PollutedContentError(input.content);
    }
  }
}
