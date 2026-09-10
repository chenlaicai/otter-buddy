import type { Context } from "hono";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { Logger } from "@usecases/ports/logger";
import type { Entry } from "@entities/conversation/entry";
import type { EntryDTO } from "@contract/api/entry";
import { handleError, param } from "../http-error";

/**
 * F20260910ctlv 彻底切换：entries 时间线唯一读端点。
 * 前端历史/分页/增量刷新/未读定位全部走这里（messages 渲染端点退役）。
 * 只读——entry 写入由 agent-invoker/tool-factory/send-entry 负责。
 */

export class EntryController {
  constructor(
    private readonly entryRepo: EntryRepository,
    private readonly logger: Logger,
  ) {}

  /** GET /api/conversations/:id/entries?limit=&before=&after=
   *  before：向上翻页（DESC 取再反转为 ASC）；after：增量刷新（ASC）
   */
  async list(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const limitRaw = c.req.query("limit");
      const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 50, 1), 200) : 50;
      const before = c.req.query("before") || undefined;
      const after = c.req.query("after") || undefined;

      if (after) {
        // after 游标：取该 entry 之后的新条目（升序）
        const entries = await this.entryRepo.getEntriesAfter(after, limit);
        const hasMore = entries.length === limit;
        return c.json({ entries: entries.map(toEntryDTO), hasMore });
      }

      const entries = await this.entryRepo.getEntries(conversationId, {
        limit: limit + 1, // 多取 1 条判 hasMore
        before,
      });
      const hasMore = entries.length > limit;
      const items = hasMore ? entries.slice(0, limit) : entries;
      // DESC 查询结果反转为时间升序（前端按时间序渲染）
      return c.json({ entries: items.reverse().map(toEntryDTO), hasMore });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}

/** Entry 实体 → DTO */
function toEntryDTO(e: Entry): EntryDTO {
  return {
    id: e.id,
    conversationId: e.conversationId,
    sequenceNum: e.sequenceNum,
    entryType: e.entryType,
    senderType: e.senderType,
    senderId: e.senderId,
    body: e.body,
    invokeId: e.invokeId,
    yieldTargets: e.yieldTargets,
    turnId: e.turnId,
    status: e.status,
    source: e.source,
    metadata: e.metadata,
    senderName: e.senderName,
    contextTokens: e.contextTokens,
    contextTokensMax: e.contextTokensMax,
    createdAt: e.createdAt,
    completedAt: e.completedAt,
  };
}
