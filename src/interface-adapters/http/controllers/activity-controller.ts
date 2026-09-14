/**
 * 活动页 controller（F20260912avlb）：三域台账只读端点。
 *
 * 全只读——无任何写端点（搭档拍板「当前我不需要处理事件」）。
 * summary 端点一期裁掉（方案取舍：避免无人点的红点噪音；使用数据说话）。
 */
import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { SignalEventRepository } from "@usecases/signal/signal-event-repository";
import type { DispatchRecordRepository } from "@usecases/dispatch/dispatch-record-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { SignalQueryFilter } from "@entities/signal/signal-event";
import type { HealingEvent, HealingEventStatus } from "@entities/healing/healing-event";
import type { SignalEvent } from "@entities/signal/signal-event";
import type { DispatchRecord } from "@entities/dispatch/dispatch-record";
import type {
  HealingEventDTO, HealingEventsResponseDTO,
  SignalEventDTO, SignalEventsResponseDTO,
  DispatchRecordDTO, DispatchRecordsResponseDTO,
} from "@contract/api/activity";

/** healing 事件数百条量级，controller 内存过滤 errorType 安全（方案 Part 2） */
const HEALING_LIST_LIMIT = 500;

export class ActivityController {
  constructor(
    private readonly healingRepo: HealingEventRepository,
    private readonly signalRepo: SignalEventRepository,
    private readonly dispatchRepo: DispatchRecordRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly logger: Logger,
  ) {}

  /** GET /api/activity/healing?status=&errorType=&conversationId=&limit= */
  async healing(c: Context): Promise<Response> {
    const status = (c.req.query("status") as HealingEventStatus | undefined) ?? "open";
    const _errorType = c.req.query("errorType");
    const conversationId = c.req.query("conversationId");
    const limit = Math.min(Number(c.req.query("limit")) || HEALING_LIST_LIMIT, HEALING_LIST_LIMIT);

    // conversationId 有值走 findByConversation（逐对话浏览）；无值全表（按 status）
    const events = conversationId
      ? await this.healingRepo.findByConversation(conversationId)
      : await this.healingRepo.findAll(status, limit);

    // findByConversation 无 status 参数——与全表路径统一在内存过滤（数据量数百条安全）
    const filtered = conversationId
      ? events.filter(e => e.status === status)
      : events;

    const dto: HealingEventsResponseDTO = {
      events: filtered.map(toHealingDTO),
      count: filtered.length,
    };
    return c.json(dto);
  }

  /** GET /api/activity/signals?status=&type=&limit= */
  async signals(c: Context): Promise<Response> {
    const filter: SignalQueryFilter = {};
    const status = c.req.query("status");
    const type = c.req.query("type");
    if (status === "pending" || status === "resolved" || status === "dismissed") filter.status = status;
    if (type === "objection" || type === "blocked" || type === "halt") filter.type = type;
    const limit = Math.min(Number(c.req.query("limit")) || 200, 500);

    const signals = await this.signalRepo.findAll(filter, limit);
    const dto: SignalEventsResponseDTO = {
      signals: signals.map(toSignalDTO),
      count: signals.length,
    };
    return c.json(dto);
  }

  /** GET /api/activity/dispatch?conversationId=&status=&limit= */
  async dispatch(c: Context): Promise<Response> {
    const conversationId = c.req.query("conversationId");
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit")) || 200, 500);

    const records = await this.dispatchRepo.findByFilter({
      conversationId: conversationId || undefined,
      status: status === "created" || status === "dispatched" || status === "dissolved" ? status : undefined,
      limit,
    });

    // 「在场」= 实时 join 参与者表（不落库）——按 conversation 分组批量预取，避免 N+1
    const presentByConv = new Map<string, Set<string>>();
    const convIds = [...new Set(records.map(r => r.conversationId))];
    for (const convId of convIds) {
      try {
        const participants = await this.conversationRepo.getActiveParticipants(convId);
        presentByConv.set(convId, new Set(participants.map(p => p.otterId)));
      } catch (e) {
        // 对话可能已不存在：在场信息降级为空集，不阻塞台账展示
        this.logger.warn("activity dispatch: getActiveParticipants failed", {
          conversationId: convId, error: e instanceof Error ? e.message : String(e),
        });
        presentByConv.set(convId, new Set());
      }
    }

    const dto: DispatchRecordsResponseDTO = {
      records: records.map(r => toDispatchDTO(r, presentByConv.get(r.conversationId)?.has(r.otterId) ?? false)),
      count: records.length,
    };
    return c.json(dto);
  }
}

function toHealingDTO(e: HealingEvent): HealingEventDTO {
  return {
    id: e.id,
    conversationId: e.conversationId,
    otterId: e.otterId,
    errorType: e.errorType,
    severity: e.severity,
    description: e.description,
    suggestion: e.suggestion,
    status: e.status,
    createdAt: e.createdAt,
    resolvedAt: e.resolvedAt,
  };
}

function toSignalDTO(s: SignalEvent): SignalEventDTO {
  return {
    id: s.id,
    conversationId: s.conversationId,
    messageId: s.messageId,
    fromOtterId: s.fromOtterId,
    targetOtterId: s.targetOtterId,
    type: s.type,
    severity: s.severity,
    payload: s.payload,
    status: s.status,
    resolution: s.resolution,
    resolvedBy: s.resolvedBy,
    resolvedAt: s.resolvedAt,
    createdAt: s.createdAt,
  };
}

function toDispatchDTO(r: DispatchRecord, present: boolean): DispatchRecordDTO {
  return {
    id: r.id,
    conversationId: r.conversationId,
    otterId: r.otterId,
    otterName: r.otterName,
    task: r.task,
    status: r.status,
    createdAt: r.createdAt,
    dispatchedAt: r.dispatchedAt,
    dissolvedAt: r.dissolvedAt,
    present,
  };
}
