import type { Context } from "hono";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { InvokeEvent } from "@entities/conversation/invoke";
import type { FoldedStep } from "@contract/api/invoke-event-fold";
import type { Logger } from "@usecases/ports/logger";
import type { Entry } from "@entities/conversation/entry";
import type { EntryDTO, FoldedStepDTO } from "@contract/api/entry";
import { foldInvokeEvents } from "@contract/api/invoke-event-fold";
import type { InvokeEventDTO } from "@contract/api/invoke";
import { handleError, param } from "../http-error";

/**
 * F20260913ctlv 彻底切换：entries 时间线唯一读端点。
 * 前端历史/分页/增量刷新/未读定位全部走这里（messages 渲染端点退役）。
 * 只读——entry 写入由 agent-invoker/tool-factory/send-entry 负责。
 *
 * F20261013csv3 T5：?includeEvents=true 批量投影工具调用明细——
 * 默认关闭（关闭态读端点语义不变，零额外查询）；开关打开时按条目 invokeId 批量取回
 * invoke_events，foldInvokeEvents（contract 层前后端同源）折叠成步骤投影，
 * error 摘要 ≤200 字符、每 invoke ≤20 条（体积护栏）。
 */

/** T5：error 摘要截断上限（≤200 字符——防畸形错误消息撑爆响应体） */
const EVENT_ERROR_MAX_CHARS = 200;
/** T5：每 invoke 投影步数上限（≤20 条——明细是扫读辅助，不是全量审计） */
const EVENTS_PER_INVOKE_MAX = 20;

export class EntryController {
  constructor(
    private readonly entryRepo: EntryRepository,
    private readonly logger: Logger,
    /** F20261013csv3 T5：invoke 事件批量查询（includeEvents=true 时的数据源） */
    private readonly invokeRepo?: InvokeRepository,
  ) {}

  /** GET /api/conversations/:id/entries?limit=&before=&after=&includeEvents=true
   *  before：向上翻页（DESC 取再反转为 ASC）；after：增量刷新（ASC）
   */
  async list(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const limitRaw = c.req.query("limit");
      const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 50, 1), 200) : 50;
      const before = c.req.query("before") || undefined;
      const after = c.req.query("after") || undefined;
      const includeEvents = c.req.query("includeEvents") === "true";

      if (after) {
        // after 游标：取该 entry 之后的新条目（升序）
        const entries = await this.entryRepo.getEntriesAfter(after, limit);
        const hasMore = entries.length === limit;
        const projected = includeEvents ? await this.withEvents(entries) : entries;
        return c.json({ entries: projected.map(toEntryDTO), hasMore });
      }

      const entries = await this.entryRepo.getEntries(conversationId, {
        limit: limit + 1, // 多取 1 条判 hasMore
        before,
      });
      const hasMore = entries.length > limit;
      const items = hasMore ? entries.slice(0, limit) : entries;
      // DESC 查询结果反转为时间升序（前端按时间序渲染）
      const projected = includeEvents ? await this.withEvents(items) : items;
      return c.json({ entries: projected.reverse().map(toEntryDTO), hasMore });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** T5 批量投影：收集条目的 invokeId（去重）→ 一次批量查询 invoke_events →
   *  逐 invoke fold（≤20 步）→ 挂到对应条目的 events 字段。 */
  private async withEvents(entries: Entry[]): Promise<Entry[]> {
    if (!this.invokeRepo) return entries;
    const invokeIds = [...new Set(entries.map(e => e.invokeId).filter((id): id is string => !!id))];
    if (invokeIds.length === 0) return entries;
    const allEvents = await this.invokeRepo.getInvokeEventsByInvokeIds(invokeIds);
    const byInvoke = new Map<string, InvokeEventDTO[]>();
    for (const ev of allEvents) {
      const list = byInvoke.get(ev.invokeId);
      if (list) list.push(toInvokeEventDTO(ev));
      else byInvoke.set(ev.invokeId, [toInvokeEventDTO(ev)]);
    }
    return entries.map(e => {
      if (!e.invokeId) return e;
      const evts = byInvoke.get(e.invokeId);
      if (!evts) return e;
      const steps = foldInvokeEvents(evts, { invokeEnded: true }).slice(0, EVENTS_PER_INVOKE_MAX);
      return { ...e, events: steps.map(toFoldedStepDTO) };
    });
  }
}

/** Entry 实体 → DTO */
function toEntryDTO(e: Entry & { events?: FoldedStepDTO[] }): EntryDTO {
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
    status: e.status,
    source: e.source,
    metadata: e.metadata,
    senderName: e.senderName,
    // F20260921otcl：发送者出生色透出（repo 读路径 join otters 填充；user/system 条目 null）
    senderColor: e.senderColor ?? null,
    ...(e.senderOtterType && { senderOtterType: e.senderOtterType }),
    contextTokens: e.contextTokens,
    contextTokensMax: e.contextTokensMax,
    createdAt: e.createdAt,
    completedAt: e.completedAt,
    // F20260913ctlv 终审修复：附件读出链补通（repo attachAttachments 已填充 Entry 实体）
    ...(e.attachments && e.attachments.length > 0 && {
      attachments: e.attachments.map(a => ({
        id: a.id,
        kind: a.kind,
        originalName: a.originalName,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        width: a.width,
        height: a.height,
      })),
    }),
    // F20261013csv3 T5：过程明细（includeEvents=true 时携带）
    ...(e.events && { events: e.events }),
  };
}

/** InvokeEvent 实体 → DTO（与 invoke-controller.toInvokeEventDTO 同源口径） */
function toInvokeEventDTO(ev: InvokeEvent): InvokeEventDTO {
  return {
    id: ev.id,
    invokeId: ev.invokeId,
    eventType: ev.eventType,
    payload: ev.payload,
    sequenceNum: ev.sequenceNum,
    createdAt: ev.createdAt,
  };
}

/** FoldedStep → DTO（error 摘要截断 ≤200 字符；rawEventIds 是内部溯源字段，投影层剥除） */
function toFoldedStepDTO(step: FoldedStep): FoldedStepDTO {
  switch (step.kind) {
    case "call":
      return {
        kind: "call",
        name: step.name,
        args: step.args,
        result: step.result,
        isError: step.isError,
        pending: step.pending,
        interrupted: step.interrupted,
        ts: step.ts,
        tsEnd: step.tsEnd,
      };
    case "think":
      return { kind: "think", text: step.text, ts: step.ts };
    case "speak":
      return { kind: "speak", body: step.body, ts: step.ts };
    case "error":
      return { kind: "error", message: step.message.slice(0, EVENT_ERROR_MAX_CHARS), ts: step.ts };
    case "user":
      return { kind: "user", text: step.text, ts: step.ts };
  }
}
