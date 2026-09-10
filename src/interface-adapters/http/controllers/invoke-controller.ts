import type { Context } from "hono";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { Logger } from "@usecases/ports/logger";
import type { Invoke, InvokeEvent } from "@entities/conversation/invoke";
import type { InvokeDTO, InvokeEventDTO } from "@contract/api/invoke";
import { handleError, param } from "../http-error";

/**
 * F20260910ctlv Phase 4：invoke 只读查询端点。
 * Session 弹窗（invoke 列表 + 流式过程展开）与右侧栏状态面板刷新的数据源。
 * 只读——invoke 生命周期写入由 agent-invoker/orchestrator 负责（Phase 2 已建）。
 */

export class InvokeController {
  constructor(
    private readonly invokeRepo: InvokeRepository,
    private readonly logger: Logger,
  ) {}

  /** GET /api/conversations/:id/invokes?limit=&before=&otterId= */
  async list(c: Context): Promise<Response> {
    try {
      const conversationId = param(c, "id");
      const limitRaw = c.req.query("limit");
      const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 50, 1), 200) : 50;
      const before = c.req.query("before") || undefined;
      const otterId = c.req.query("otterId") || undefined;
      const invokes = await this.invokeRepo.getInvokes(conversationId, {
        limit: limit + 1, // 多取 1 条判 hasMore
        before,
        otterId,
      });
      const hasMore = invokes.length > limit;
      const items = hasMore ? invokes.slice(0, limit) : invokes;
      return c.json({ invokes: items.map(toInvokeDTO), hasMore });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** GET /api/invokes/:id/events（单次 invoke 的全部流式过程事件） */
  async getEvents(c: Context): Promise<Response> {
    try {
      const invokeId = param(c, "id");
      const invoke = await this.invokeRepo.getInvokeById(invokeId);
      if (!invoke) {
        return c.json({ error: "invoke not found" }, 404);
      }
      const events = await this.invokeRepo.getInvokeEvents(invokeId);
      return c.json({ invoke: toInvokeDTO(invoke), events: events.map(toInvokeEventDTO) });
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }
}

/** Invoke 实体 → DTO（字段一一对应；tokenUsage 拆列已在实体内完成） */
function toInvokeDTO(inv: Invoke): InvokeDTO {
  return {
    id: inv.id,
    conversationId: inv.conversationId,
    otterId: inv.otterId,
    status: inv.status,
    triggerEntryId: inv.triggerEntryId,
    talkingStonePassedTo: inv.talkingStonePassedTo,
    startedAt: inv.startedAt,
    endedAt: inv.endedAt,
    toolCallCount: inv.toolCallCount,
    tokenUsageInput: inv.tokenUsageInput,
    tokenUsageOutput: inv.tokenUsageOutput,
  };
}

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
