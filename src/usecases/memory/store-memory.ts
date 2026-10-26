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

/** #509: 污染判定的 trim 阈值（<10 字符的 chunk 无检索价值，写入即污染）
 *  双阈值设计（PR #519 审视发现 1 的回应）：
 *  - execute/replaceBySource 只拦「空」（trim 后 0 字符）——初版曾用 <10 阈值，
 *    误伤了存量测试里的 9 字符合法短消息（"用户询问了天气情况"），故收窄；
 *    消息/fact 类内容的短文本（如「继续」）是合法记忆，不可误伤。
 *  - chunk 批量路径（replaceChunksBySource）用 <10 阈值——文档段落 <10 字符
 *    无检索价值（历史污染实证：8-26 入库 43% 为 `.` / `\n` / `2.` 类碎片）。
 *  语义根源：两类内容的价值下限不同，阈值故意不统一。 */
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
    const id = this.generateId(input.sourceTable, input.sourceId);

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
   * F20260915midu（#942）：投影条目主键 = 源实体 ID，消灭双 ID。
   * 此前投影条目另生成 UUID、仅 source_id 回指——link_memory 拿源实体 ID 直查
   * memory_entries 命中不了投影（entry not found），资源/文档类节点永远没有边。
   *
   * 豁免（保持随机 UUID）：
   * - `signals`：signals 表 INTEGER AUTOINCREMENT 主键 + upsert 复用导致 1:N
   *   （一条信号记录 critical 次数累计投影多条 fact，实证 13868 条 ↔ 122 个 signal id），
   *   统一会让不同信号的整数 ID 在 UUID 命名空间里互撞。修根超出本特性边界，
   *   详见特性文档 F20260915midu「设计」节——有意识的边界，不是漏接。
   * - chunk 类不走本路径（replaceChunksBySource 独立生成，1:N 共享 source_id 且 D3 禁边）。
   */
  private generateId(sourceTable: string, sourceId: string): string {
    return sourceTable === "signals" ? crypto.randomUUID() : sourceId;
  }

  /**
   * F20260812mrcq Part 1：fire-and-forget embedding 的统一封装。
   * embed 成功 → storeEmbedding；任一失败 → enqueueRetry 入队（ON CONFLICT 保留 attempts）。
   * 三处调用点（execute / replaceBySource / replaceChunksBySource）共用，避免重复。
   *
   * F20261020slvg：
   * - waitSlot——活消息不再弹回 retry 队列等 1h tick，而是 FIFO 排队，
   *   由 worker 真实吞吐节流（回填泄洪期间活消息也能及时 embedding）。
   * - salvage 双轨——超时只是「不再等」：enqueueRetry 兜底入队，同时 worker
   *   晚到的向量经 salvage 落库 + markTaskDone 去重。窗口内可能重算一次，
   *   storeEmbedding 是 DELETE+INSERT 幂等覆盖，收敛不发散。
   *   注：晚到 salvage 可能给已删 entry 写孤儿 vec 行——searchVec 有
   *   JOIN memory_entries 守卫，孤儿永不浮现，惰性垃圾接受（窗口现状即存在）。
   */
  private fireAndForgetEmbed(entryId: string, content: string): void {
    this.embeddingGateway
      .embed(this.truncateForEmbed(content), {
        waitSlot: true,
        salvage: (emb) => {
          void this.writer.storeEmbedding(entryId, emb)
            .then(() => this.queue.markTaskDone(entryId))
            .catch(err =>
              this.logger.warn(`Embedding salvage failed for ${entryId} (task stays in retry queue): ${err}`),
            );
        },
      })
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
    const id = this.generateId(input.sourceTable, input.sourceId);
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
    // F20260915midu（#942）：chunk 保持随机 UUID——1:N 共享 source_id 主键不能直接用，
    // 且 D3 禁边 + replaceEntriesBySource 每次重建，统一 ID 无收益（见特性文档）。
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

    // F20261013ebps：批量 embed——embedBatch 一次 postMessage 传全部文本，
    // worker 端 batch 推理（吞吐远高于逐条 embed）。embedBatch 不可用时回落逐条。
    // 背压溢出时 batch 直接 reject，catch 后逐条入 retry 队列（不丢失）。
    this.fireAndForgetEmbedBatch(entries.map(e => ({ id: e.id, content: e.content })));

    return entries.map((e) => e.id);
  }

  /**
   * F20261013ebps：批量 fire-and-forget embedding。
   * 优先走 embedBatch（一次 postMessage），失败时回落逐条 fireAndForgetEmbed。
   * 每条失败独立入 retry 队列——batch 内部分失败不拖累健康 chunk。
   *
   * 流速控制（对抗审视 #1465 严重发现 1）：sync 启动期 600+ 文档串行 await
   * replaceChunksBySource，但 embed 是 fire-and-forget——前一批未完成后一批已发起，
   * 前 50 篇即可耗尽背压 slot，第 51 篇起全部 reject 走 retry 慢路径。
   * F20261020slvg：waitSlot 直接内嵌 embedBatch（槽满挂起，唤醒→准入在同一同步段），
   * 软限流替代硬溢出，sync 速度由 worker 真实吞吐节流。
   */
  private fireAndForgetEmbedBatch(items: Array<{ id: string; content: string }>): void {
    if (items.length === 0) return;

    const gateway = this.embeddingGateway;
    if (typeof gateway.embedBatch === "function") {
      const embedBatch = gateway.embedBatch.bind(gateway);
      const texts = items.map(item => this.truncateForEmbed(item.content));
      // F20261020slvg：waitSlot 内嵌进 embedBatch（替代 acquireSlot→embedBatch 两步配对，
      // 消灭唤醒后到准入之间的 TOCTOU 竞态）；salvage 同 fireAndForgetEmbed 双轨语义
      embedBatch(texts, {
        waitSlot: true,
        // F20261026emct delta 处置（严重 1）：startIndex 分片场景下指向整批第 startIndex 条起；
        // 非分批路径 service 不传（undefined = 0）。按 startIndex 对位写入，杜绝跨子批错位污染
        salvage: (embeddings, startIndex) => {
          void (async () => {
            const base = startIndex ?? 0;
            for (let i = 0; i < embeddings.length; i++) {
              const item = items[base + i];
              if (!item) {
                this.logger.warn(
                  `Embedding batch salvage index out of range: base=${base} i=${i} items=${items.length} (skip)`,
                );
                continue;
              }
              try {
                await this.writer.storeEmbedding(item.id, embeddings[i]);
                await this.queue.markTaskDone(item.id);
              } catch (err) {
                this.logger.warn(
                  `Embedding batch salvage failed for ${item.id} (task stays in retry queue): ${err}`,
                );
              }
            }
          })();
        },
      })
        .then((embeddings) => {
          for (let i = 0; i < items.length; i++) {
            this.writer.storeEmbedding(items[i].id, embeddings[i]).catch((err) => {
              this.logger.warn(`Failed to store embedding for ${items[i].id}: ${err}`);
              this.queue.enqueueRetry(items[i].id, err).catch(e =>
                this.logger.error(`enqueueRetry failed for ${items[i].id}: ${e}`),
              );
            });
          }
        })
        .catch((err) => {
          // batch 整体失败（背压/超时/worker 不可用）——逐条入 retry 队列
          this.logger.debug(`Batch embedding failed (${items.length} items), enqueueing individually: ${err}`);
          for (const item of items) {
            this.queue.enqueueRetry(item.id, err).catch(e =>
              this.logger.error(`enqueueRetry failed for ${item.id}: ${e}`),
            );
          }
        });
    } else {
      // embedBatch 不可用（mock / 旧实现）——回落逐条
      for (const item of items) {
        this.fireAndForgetEmbed(item.id, item.content);
      }
    }
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
