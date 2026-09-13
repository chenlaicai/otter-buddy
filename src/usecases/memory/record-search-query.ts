/**
 * RecordSearchQuery：检索埋点 use case。
 *
 * F20260826rcmm Phase 0：search_memory 每次真实调用后记录
 * （查询 + top 命中 + 对话上下文快照），供评估基线标注。
 *
 * 设计约束（方案决策）：
 * - fire-and-forget：埋点失败只 warn 不阻断检索（评估数据允许丢失，检索不可用不可接受）
 * - 上下文消息数 = 5（标注者还原意图够用，控制行体积）
 * - 预览截断 160 字符/条
 */

import type { SearchQueryContextMessage } from "@entities/memory/search-query-log";
import type { SearchQueryLogRepository } from "./search-query-log-repository";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { Logger } from "@usecases/ports/logger";

const CONTEXT_MESSAGE_COUNT = 5;
const PREVIEW_MAX_CHARS = 160;
const TOP_ENTRY_IDS_COUNT = 5;

export class RecordSearchQuery {
  constructor(
    private readonly repo: SearchQueryLogRepository,
    /** F20260913ctlv 收尾批3：上下文快照切 entries（时间线唯一真相源） */
    private readonly entryRepo: EntryRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * 记录一次检索调用。不抛错——内部 catch 后 warn（fire-and-forget）。
   * @param callerId 发起方 Otter ID（agent 路径）；HTTP 路径传 null
   * @param beforeMessageId 上下文快照上界（不含）：触发检索的当前消息 ID。
   *        传入后快照取「查询发起前」的上下文，避免 agent 检索动作自身的发言
   *        混入快照污染意图还原（kimi 审视发现 1）。
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
    try {
      const contextMessages = await this.buildContextPreview(input.conversationId, input.beforeMessageId);
      await this.repo.insert({
        query: input.query,
        conversationId: input.conversationId,
        callerId: input.callerId,
        detailLevel: input.detailLevel,
        library: input.library,
        limitCount: input.limitCount,
        // 截前 5：标注只核对 top-5 是否含理想条目（recall@5 基线）
        topEntryIds: input.topEntryIds.slice(0, TOP_ENTRY_IDS_COUNT),
        total: input.total,
        contextMessages,
      });
    } catch (err) {
      // 埋点失败不阻断检索主流程（评估数据允许部分缺失）
      this.logger.warn("search query log failed (ignored)", { err: String(err), query: input.query.slice(0, 50) });
    }
  }

  /** 取查询前最近 5 条对话条目的预览快照（标注者还原查询意图用）。
   *  F20260913ctlv 收尾批3：数据源切 entries（speak+user 合并按 seq 倒取）。
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
        preview: (e.body ?? "").slice(0, PREVIEW_MAX_CHARS),
      }));
  }
}
