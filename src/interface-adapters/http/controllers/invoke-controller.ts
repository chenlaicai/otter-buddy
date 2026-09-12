import type { Context } from "hono";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { Logger } from "@usecases/ports/logger";
import type { Invoke, InvokeEvent } from "@entities/conversation/invoke";
import type { InvokeDTO, InvokeEventDTO } from "@contract/api/invoke";
import { handleError, param } from "../http-error";
import type { AgentInvoker } from "../../agent-runtime/agent-invoker";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { MessageBroadcaster } from "@usecases/im/message-broadcaster";
import { streamEvents } from "../sse-streamer";
import type { SSEEvent } from "@contract/sse/events";

/**
 * F20260910ctlv Phase 4：invoke 只读查询端点。
 * Session 弹窗（invoke 列表 + 流式过程展开）与右侧栏状态面板刷新的数据源。
 * 只读——invoke 生命周期写入由 agent-invoker/orchestrator 负责（Phase 2 已建）。
 */

export class InvokeController {
  constructor(
    private readonly invokeRepo: InvokeRepository,
    private readonly logger: Logger,
    /** F20260910ctlv 彻底切换：invoke 中止（AgentInvoker） */
    private readonly agentInvoker?: AgentInvoker,
    /** F20260910ctlv 彻底切换：重试调度链（链引擎） */
    private readonly dispatchChainEngine?: DispatchChainEngine,
    /** F20260910ctlv 彻底切换：重试 SSE 流订阅（broadcaster） */
    private readonly messageBroadcaster?: MessageBroadcaster,
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

  /** POST /api/invokes/:id/abort——中止运行中 invoke（F20260910ctlv 彻底切换：停止按钮唯一后端） */
  async abort(c: Context): Promise<Response> {
    try {
      const invokeId = param(c, "id");
      const invoke = await this.invokeRepo.getInvokeById(invokeId);
      if (!invoke) {
        return c.json({ error: "invoke not found" }, 404);
      }
      if (invoke.status !== "running") {
        return c.json({ error: `invoke already in terminal status: ${invoke.status}` }, 409);
      }
      if (!this.agentInvoker) {
        return c.json({ error: "agent invoker not configured" }, 500);
      }
      // invokeId 兼任 SDK session 键控（agent-invoker 已把 messageId 语义切到 invokeId）
      this.agentInvoker.abort(invoke.otterId, invokeId);
      return c.json({ status: "aborted" }, 202);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** POST /api/invokes/:id/retry
   *  F20260910ctlv 彻底切换：invoke 重试 = 对该獭重新 invoke 一次（新 invoke 行 + 新时间线）。
   *  session 上下文已完整（原 invoke 的过程都在 session 里），重试 prompt 用简短续跑指令。
   *  SSE 流与正常发言链一致（entry.* / invoke.* 事件经 broadcaster 推送）。 */
  async retry(c: Context): Promise<Response> {
    try {
      const invokeId = param(c, "id");
      const invoke = await this.invokeRepo.getInvokeById(invokeId);
      if (!invoke) {
        return c.json({ error: "invoke not found" }, 404);
      }
      if (invoke.status === "completed") {
        return c.json({ error: `invoke is not in a retryable status: ${invoke.status}` }, 409);
      }
      return this.retryOtter(c, invoke.conversationId, invoke.otterId, invokeId);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** POST /api/otters/:id/retry?conversationId=xxx
   *  F20260910ctlv test17（搭档拍板）：獭锚重试——重试的是「该獭的 session」（上下文载体），
   *  invoke 只是 session 上的一次执行记录。invokeId 锚的「重试哪次」是伪精度（triggerMessageId
   *  在链引擎未被消费、retry prompt 不引用旧 invoke），故改为獭锚简化链路。
   *  定位：该獭最近一次非 completed invoke（无可重试目标 409）；session 上下文承载原始任务。 */
  async retryByOtter(c: Context): Promise<Response> {
    try {
      const otterId = param(c, "id");
      const conversationId = c.req.query("conversationId");
      if (!conversationId) {
        return c.json({ error: "conversationId is required" }, 400);
      }
      /** 最近一次非 completed invoke 作可重试校验 + 触发锚（无 targeted retry 语义，仅兜底校验） */
      const recent = await this.invokeRepo.getInvokes(conversationId, { otterId, limit: 1 });
      const latest = recent[0];
      if (!latest) {
        return c.json({ error: "no invoke found for this otter" }, 404);
      }
      if (latest.status === "completed") {
        return c.json({ error: `otter's latest invoke is not in a retryable status: ${latest.status}` }, 409);
      }
      return this.retryOtter(c, conversationId, otterId, latest.id);
    } catch (err) {
      return handleError(c, err, this.logger);
    }
  }

  /** 重试核心：对指定獭重新 invoke 一次（session 上下文承载原始任务，SSE 流同正常发言链）。
   *  F20260910ctlv test17：running（用户刚点中断、abort 终态化异步收敛中）也放行——
   *  消除「中断后立即重试撞 409」的窗口竞态。triggerAnchor 仅作链引擎记账原点（非差异化逻辑）。 */
  private retryOtter(c: Context, conversationId: string, otterId: string, triggerAnchor: string): Response {
    try {
      if (!this.agentInvoker || !this.dispatchChainEngine) {
        return c.json({ error: "retry pipeline not configured" }, 500);
      }

      const { response, push, close } = streamEvents(c);
      let unsubscribe: (() => void) | undefined;
      if (this.messageBroadcaster) {
        unsubscribe = this.messageBroadcaster.subscribeEvents(conversationId, (event: SSEEvent) => { push(event); });
      }

      // 链引擎续跑：目标 = 原獭；prompt = 重试续跑指令（session 上下文承载原始任务）
      const retryPrompt = "[系统] 上一次执行中断了。请基于会话中的上下文继续完成任务，用 speak 输出结论后 yield 交棒。";
      this.dispatchChainEngine.executeChain({
        conversationId,
        userMessageContent: retryPrompt,
        senderId: "user",
        initialTargets: [otterId],
        triggerMessageId: triggerAnchor,
        invokeFn: async (params) => {
          const r = await this.agentInvoker!.invokeConversation({
            otterId: params.otterId,
            conversationId: params.conversationId,
            userMessageContent: params.userMessageContent,
            senderId: params.senderId,
            retryCount: 1,
            manualRetry: true,
            ...(params.images && { images: params.images }),
          });
          return { messageId: r.invokeId };
        },
      })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error("invoke retry 调度异常", err instanceof Error ? err : new Error(msg), { otterId });
          push({ event: "error", data: { message: `重试失败: ${msg}`, otterId } });
        })
        .finally(() => {
          unsubscribe?.();
          setTimeout(() => { push({ event: "stream.end", data: {} }); close(); }, 100);
        });

      return response;
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
