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
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { Logger } from "@usecases/ports/logger";
import { aggregateBody } from "@entities/conversation/message";

const CONTEXT_MESSAGE_COUNT = 5;
const PREVIEW_MAX_CHARS = 160;
const TOP_ENTRY_IDS_COUNT = 5;

export class RecordSearchQuery {
  constructor(
    private readonly repo: SearchQueryLogRepository,
    private readonly queryMessage: QueryMessage,
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

  /** 取查询前最近 5 条消息的预览快照（标注者还原查询意图用）。
   * beforeMessageId 存在时排除该消息及之后的消息——快照 = 查询发起前的上下文。 */
  private async buildContextPreview(
    conversationId: string,
    beforeMessageId?: string | null,
  ): Promise<SearchQueryContextMessage[]> {
    // DESC 取最近 5 条再正序还原（上下文阅读顺序）
    const messages = await this.queryMessage.getMessages(conversationId, {
      limit: CONTEXT_MESSAGE_COUNT,
      ...(beforeMessageId ? { before: beforeMessageId } : {}),
    });
    return messages
      .reverse()
      .map((m) => ({
        id: m.id,
        senderId: m.senderId,
        role: m.senderType,
        preview: aggregateBody(m.segments).slice(0, PREVIEW_MAX_CHARS),
      }));
  }
}
