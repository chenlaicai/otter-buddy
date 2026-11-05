import type {
  MemoryLayer,
  MemoryContentType,
  RetrievalGranularity,
} from "@entities/memory/memory-entry";
import type { MemoryWriter } from "./memory-writer";
import type { MemoryQueue } from "./memory-queue";
import { EMBED_TASK_PRIORITY, EMBED_QUEUE_HIGH_WATER } from "./memory-queue";
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
 *  双阈值设计（PR #519 回应）：
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

  /**
   * F20261105embqg S3（对抗审视发现 1）：全量 chunk 提交的分批粒度——每批提交前
   * 复查联合水位，保证任一时刻「在飞 bulk + 排队 waiter」不超 HIGH_WATER。
   * 20 与单批 token 闸门（budget 8192）量级协调：一篇文章的 chunk 数典型 10-40。
   */
  private static readonly DOC_CHUNK_GATE_BATCH = 20;

  /**
   * F20261105embqg S3：在飞 bulk 计数（fireAndForgetEmbedBatch 提交 +1 / settle -1）。
   * 含挂起在槽位队列的 waiter（未 settle 的都是未完成的在飞工作）。
   */
  private bulkInFlight = 0;

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
     *  F20260812mrcq Part 1：失败入 embedding_tasks 队列，retry worker 兜底
     *  F20261105embqg S2：live 优先级（0）——消息投影是用户在场等检索的路径，
     *  积压泄洪期间插队（槽位与队列两层） */
    this.fireAndForgetEmbed(id, input.content, EMBED_TASK_PRIORITY.live);

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
   *
   * F20261105embqg S2：priority 参数化——execute/replaceBySource（消息/fact）传 live(0)，
   * embedBatch 不可用时的逐条回落传 bulk(2)。槽位排队与 retry 入队同优先级，
   * 两层（S2a/S2b）语义对齐。
   */
  private fireAndForgetEmbed(entryId: string, content: string, priority: number = EMBED_TASK_PRIORITY.normal): void {
    this.embeddingGateway
      .embed(this.truncateForEmbed(content), {
        waitSlot: true,
        priority,
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
          this.queue.enqueueRetry(entryId, err, priority).catch(e =>
            this.logger.error(`enqueueRetry failed for ${entryId}: ${e}`),
          );
        });
      })
      .catch((err) => {
        this.logger.debug(`Embedding generation failed for ${entryId}: ${err}`);
        this.queue.enqueueRetry(entryId, err, priority).catch(e =>
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

    // F20260803fbit + F20260812mrcq Part 1：截断防超长 body OOM worker；失败入队。
    // F20261105embqg S2：fact 类走 normal（1）——量小价值密度高，不与 bulk 重算同档
    this.fireAndForgetEmbed(id, input.content, EMBED_TASK_PRIORITY.normal);

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

    // F20261105embqg S3：生产端水位闸门（对抗审视发现 1 修正版：联合水位 + 持续复查）。
    // 判据不是单次预查 pendingTaskCount，而是「retry pending + 在飞 bulk」联合水位：
    //   - pendingTasks：embedding_tasks 里等待消费的任务（首次从 0 灌入时为 0，
    //     但在飞 bulk 会持续增长——所以不能只看它）
    //   - bulkInFlight：已提交未完成的 bulk 请求计数（含挂起在槽位队列的 waiter）
    // 每 DOC_CHUNK_GATE_BATCH（20）个 chunk 提交一批前复查水位，任一时刻在飞+排队的
    // bulk 工作量有硬上界 HIGH_WATER，首次洪峰（对抗审视复现：空队列 2001 条全提交）
    // 与已有积压两种形态都被限住。消费持续受闸而非预查一次。
    // 跳过即安全：chunk 保持暗条目（FTS5 关键词检索不受影响）；恢复路径由
    // retry worker 空闲回填（见 embedding-retry-worker.ts S3 回填，对抗审视发现 3）
    // 与下次 sync 兑现，不依赖重启。
    if (typeof this.queue.pendingTaskCount === "function") {
      const batch = Math.min(entries.length, StoreMemory.DOC_CHUNK_GATE_BATCH);
      for (let offset = 0; offset < entries.length; offset += batch) {
        const pendingTasks = await this.queue.pendingTaskCount();
        const inFlightBulk = this.bulkInFlight;
        if (pendingTasks + inFlightBulk >= EMBED_QUEUE_HIGH_WATER) {
          const skipped = entries.length - offset;
          this.logger.warn(
            `Embedding queue at high water (pending=${pendingTasks} + bulkInFlight=${inFlightBulk} >= ${EMBED_QUEUE_HIGH_WATER}), skipping bulk chunk embed for ${skipped} chunks of ${inputs[0]?.sourceId} (dark entries, refilled by idle backfill)`,
            { action: "embed_queue_high_water_skip", pending: pendingTasks, inFlightBulk, threshold: EMBED_QUEUE_HIGH_WATER, skipped, source: "doc_sync" },
          );
          return entries.map((e) => e.id);
        }
        const slice = entries.slice(offset, offset + batch).map(e => ({ id: e.id, content: e.content }));
        this.fireAndForgetEmbedBatch(slice);
      }
      return entries.map((e) => e.id);
    }

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
   * 流速控制（#1465）：sync 启动期 600+ 文档串行 await
   * replaceChunksBySource，但 embed 是 fire-and-forget——前一批未完成后一批已发起，
   * 前 50 篇即可耗尽背压 slot，第 51 篇起全部 reject 走 retry 慢路径。
   * F20261020slvg：waitSlot 直接内嵌 embedBatch（槽满挂起，唤醒→准入在同一同步段），
   * 软限流替代硬溢出，sync 速度由 worker 真实吞吐节流。
   */
  private fireAndForgetEmbedBatch(items: Array<{ id: string; content: string }>): void {
    if (items.length === 0) return;

    const gateway = this.embeddingGateway;
    if (typeof gateway.embedBatch === "function") {
      // F20261105embqg S3（对抗审视发现 1）：在飞 bulk 计数——提交时 +1，
      // 无论成败（then/catch 均 settle）-1。与 pendingTaskCount 联合构成
      // 水位判据，让首次从 0 灌入的洪峰也被持续受限。
      this.bulkInFlight += items.length;
      const settle = () => { this.bulkInFlight -= items.length; };
      const embedBatch = gateway.embedBatch.bind(gateway);
      const texts = items.map(item => this.truncateForEmbed(item.content));
      // F20261020slvg：waitSlot 内嵌进 embedBatch（替代 acquireSlot→embedBatch 两步配对，
      // 消灭唤醒后到准入之间的 TOCTOU 竞态）；salvage 同 fireAndForgetEmbed 双轨语义
      embedBatch(texts, {
        waitSlot: true,
        // F20261105embqg S2a：bulk 优先级（2）——槽位排队让位于 live 消息（0）
        priority: EMBED_TASK_PRIORITY.bulk,
        // F20261026emct：startIndex 分片场景下指向整批第 startIndex 条起；
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
          settle();
          for (let i = 0; i < items.length; i++) {
            this.writer.storeEmbedding(items[i].id, embeddings[i]).catch((err) => {
              this.logger.warn(`Failed to store embedding for ${items[i].id}: ${err}`);
              // F20261105embqg（对抗审视发现 2 尾）：批量路径的写库失败回队保持 bulk 优先级
              this.queue.enqueueRetry(items[i].id, err, EMBED_TASK_PRIORITY.bulk).catch(e =>
                this.logger.error(`enqueueRetry failed for ${items[i].id}: ${e}`),
              );
            });
          }
        })
        .catch((err) => {
          settle();
          // batch 整体失败（背压/超时/worker 不可用）——逐条入 retry 队列
          this.logger.debug(`Batch embedding failed (${items.length} items), enqueueing individually: ${err}`);
          for (const item of items) {
            this.queue.enqueueRetry(item.id, err, EMBED_TASK_PRIORITY.bulk).catch(e =>
              this.logger.error(`enqueueRetry failed for ${item.id}: ${e}`),
            );
          }
        });
    } else {
      // embedBatch 不可用（mock / 旧实现）——回落逐条（bulk 优先级：S2 两层语义对齐）
      for (const item of items) {
        this.fireAndForgetEmbed(item.id, item.content, EMBED_TASK_PRIORITY.bulk);
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

  /** 按 source + contentType 删除 chunk entries（body 清空时清理旧 chunk） */
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
