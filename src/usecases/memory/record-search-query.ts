/**
 * RecordSearchQuery：检索埋点 use case。
 *
 * search_memory 每次真实调用后记录，供评估基线标注。
 *
 * 隐私默认边界（metadata-only 为默认）：
 * - metadata-only：只写 queryHash/queryLength + 检索元数据——不读不写上下文预览、
 *   不写 query 原文；legacy query/context_messages 列落空值，不伪造脱敏正文
 * - redacted（显式评估用途）：query/preview 先过 secrets 脱敏；external 对话不记正文
 *   （query 落空、preview 不读）；带有限保留期，插入时顺带清理超期 redacted 行
 * - off：零写入零读取（record 直接返回）
 *
 * 设计约束（不变）：
 * - fire-and-forget：埋点失败只 warn 不阻断检索（评估数据允许丢失，检索不可用不可接受）
 * - 错误日志只带 queryHash，不带 query 原文
 */

import { createHash } from "node:crypto";
import type { SearchQueryContextMessage, SearchQueryLogMode } from "@entities/memory/search-query-log";
import type { SearchQueryLogRepository } from "./search-query-log-repository";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { Logger } from "@usecases/ports/logger";
import { redactSecrets } from "@usecases/security/redact-secrets";

const CONTEXT_MESSAGE_COUNT = 5;
const PREVIEW_MAX_CHARS = 160;
const TOP_ENTRY_IDS_COUNT = 5;

/** 配置（bootstrap 从环境注入；缺省 = 默认契约） */
export interface SearchQueryLogConfig {
  /** 默认 metadata-only；off 零写入 */
  mode: SearchQueryLogMode;
  /** redacted 行保留天数（有限保留期；仅 redacted 受约束） */
  redactedRetentionDays: number;
}

export const DEFAULT_SEARCH_LOG_CONFIG: SearchQueryLogConfig = {
  mode: "metadata-only",
  redactedRetentionDays: 30,
};

/** 查询原文指纹——metadata-only 模式下对齐/去重的唯一标识 */
function hashQuery(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}

export class RecordSearchQuery {
  constructor(
    private readonly repo: SearchQueryLogRepository,
    /** 收尾批3：上下文快照切 entries（时间线唯一真相源）——仅 redacted 模式读取 */
    private readonly entryRepo: EntryRepository,
    private readonly logger: Logger,
    /** 对话 kind 探测（redacted 模式判定 external 用） */
    private readonly getConversationKind: (conversationId: string) => Promise<"normal" | "external" | null>,
    private readonly config: SearchQueryLogConfig = DEFAULT_SEARCH_LOG_CONFIG,
  ) {}

  /**
   * 记录一次检索调用。不抛错——内部 catch 后 warn（fire-and-forget）。
   * @param callerId 发起方 Otter ID（agent 路径）；HTTP 路径传 null
   * @param beforeMessageId 上下文快照上界（不含）：触发检索的当前消息 ID。
   *        传入后快照取「查询发起前」的上下文，避免 agent 检索动作自身的发言
   * 混入快照污染意图还原（kimi ）。
   */
  async record(input: {
    query: string;
    conversationId: string;
    callerId: string | null;
    beforeMessageId?: string | null;
    detailLevel?: string;
    library?: string;
    limitCount?: number;
    topEntryIds: string[];
    total: number;
  }): Promise<void> {
    // off：零写入零读取——record 入口直接返回
    if (this.config.mode === "off") return;
    const queryHash = hashQuery(input.query);
    try {
      const redacted = this.config.mode === "redacted";
      // external 对话不记正文：query 落空、上下文预览不读
      let isExternal = false;
      if (redacted) {
        const kind = await this.getConversationKind(input.conversationId).catch(() => null);
        isExternal = kind === "external";
      }
      const contextMessages = redacted && !isExternal
        ? await this.buildContextPreview(input.conversationId, input.beforeMessageId)
        : [];
      await this.repo.insert({
        query: redacted && !isExternal ? redactSecrets(input.query) : "",
        conversationId: input.conversationId,
        callerId: input.callerId,
        detailLevel: input.detailLevel,
        library: input.library,
        limitCount: input.limitCount,
        // 截前 5：标注只核对 top-5 是否含理想条目（recall@5 基线）
        topEntryIds: input.topEntryIds.slice(0, TOP_ENTRY_IDS_COUNT),
        total: input.total,
        queryHash,
        queryLength: input.query.length,
        logMode: this.config.mode,
        contextMessages,
      });
      // redacted 有限保留期：插入时顺带清理超期 redacted 行（metadata-only 无正文，不受约束）
      if (redacted && this.config.redactedRetentionDays > 0) {
        await this.repo.deleteRedactedOlderThan(
          new Date(Date.now() - this.config.redactedRetentionDays * 86_400_000).toISOString(),
        );
      }
    } catch (err) {
      // 埋点失败不阻断检索主流程（评估数据允许部分缺失）；
      // 错误日志只带 queryHash——原文不进日志
      this.logger.warn("search query log failed (ignored)", { err: String(err), queryHash });
    }
  }

  /** 取查询前最近 5 条对话条目的预览快照（标注者还原查询意图用）。
   * 仅 redacted 模式调用；每条 preview 过 secrets 脱敏。
   * 收尾批3：数据源切 entries（speak+user 合并按 seq 倒取）。
   *  beforeMessageId 存在时以该条目为上界（不含）——快照 = 查询发起前的上下文。 */
  private async buildContextPreview(
    conversationId: string,
    beforeMessageId?: string | null,
  ): Promise<SearchQueryContextMessage[]> {
    const [speaks, users] = await Promise.all([
      this.entryRepo.getEntries(conversationId, { entryType: "speak", limit: CONTEXT_MESSAGE_COUNT * 2 }),
      this.entryRepo.getEntries(conversationId, { entryType: "user", limit: CONTEXT_MESSAGE_COUNT * 2 }),
    ]);
    let pool = [...speaks, ...users];

    // 上界过滤（beforeMessageId 命中时取其 sequenceNum 为界，不含锚点本身）
    if (beforeMessageId) {
      const anchor = await this.entryRepo.getEntryById(beforeMessageId).catch(() => null);
      if (anchor) {
        pool = pool.filter(e => e.sequenceNum < anchor.sequenceNum);
      }
    }

    // seq 倒序取最近 5 条再正序还原（上下文阅读顺序）
    return pool
      .sort((a, b) => b.sequenceNum - a.sequenceNum)
      .slice(0, CONTEXT_MESSAGE_COUNT)
      .reverse()
      .map((e) => ({
        id: e.id,
        senderId: e.senderId ?? "",
        role: e.senderType ?? "",
        preview: redactSecrets((e.body ?? "").slice(0, PREVIEW_MAX_CHARS)),
      }));
  }
}
