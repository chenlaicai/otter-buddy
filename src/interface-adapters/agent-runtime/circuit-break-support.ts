/**
 * CircuitBreakSupport - F20260818cbkr 连续退化熔断执行器
 *
 * Why: 熔断逻辑（healing_events 读写、restartSession、前情摘要构建）从 AgentInvoker
 * 抽取为内聚模块，invoker 保持 SDK 调用适配器职责。
 *
 * 数据源统一 healing_events：
 * - degenerate 事件：guard 每次触发落一条（orchestrator 经 TurnCallbacks 写入）
 * - circuit_break 事件：熔断执行落一条，context.newSessionId 关联新 session（上限判定 + 二级防循环）
 *
 * healingRepo 未注入（降级配置）时本模块不创建，熔断整体禁用，退化为旧 abort 语义。
 */

import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { Logger } from "@usecases/ports/logger";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingEvent } from "@entities/healing/healing-event";
import type { OtterSession } from "@entities/otter/otter-session";
import { aggregateBody } from "@entities/conversation/message";
import type { SSEEvent } from "@contract/sse/events";
import {
  buildCircuitBreakSummary,
  buildCircuitBreakFallbackSummary,
  buildCircuitBreakFailureMsg,
  buildSecondaryCircuitBreakSummary,
} from "@usecases/conversation/agent-turn-orchestrator/retry-policy";
import type { CircuitBreakInfo, HealingEventInput } from "@usecases/conversation/agent-turn-orchestrator/types";

/** 二级触发的 turn 窗口推导结果 */
interface TurnWindowCount {
  count: number;
  firstMessageId: string;
}

export class CircuitBreakSupport {
  constructor(private readonly deps: {
    manageSession: ManageSession;
    queryMessage: QueryMessage;
    sendMessage: SendMessage;
    healingRepo: HealingEventRepository;
    logger: Logger;
  }) {}

  /** degenerate guard 触发点回调：组装完整 HealingEvent 写库 */
  async recordHealingEvent(input: HealingEventInput): Promise<void> {
    await this.deps.healingRepo.create({
      id: crypto.randomUUID(),
      messageId: input.messageId,
      conversationId: input.conversationId,
      otterId: input.otterId,
      errorType: input.errorType,
      severity: input.severity,
      description: input.description,
      suggestion: input.suggestion ?? '',
      context: input.context ?? null,
      status: 'open',
      resolution: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
  }

  /** 当前 active session 是否由熔断创建（circuit_break 事件 context.newSessionId 指向它） */
  async isSessionCircuitBreakCreated(otterId: string): Promise<boolean> {
    const session = await this.deps.manageSession.getActiveSession(otterId).catch(() => null);
    if (!session) return false;
    return this.isCircuitBreakCreatedSession(otterId, session.id);
  }

  /**
   * F20260818cbkr 一级熔断执行：restart → circuit_break 事件 → true（调用方发全新 invoke）。
   * 失败降级：消息已由 orchestrator 置 failed，补系统说明 + 留痕，返回 false（行为与现状等价）。
   */
  async executeCircuitBreakRestart(info: CircuitBreakInfo, emitEvent: (event: SSEEvent) => void): Promise<boolean> {
    const summary = await this.buildCircuitBreakSummaryText(info);
    let session;
    try {
      session = await this.deps.manageSession.restartSession(info.otterId, summary);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.deps.logger.error('Circuit break restart failed, falling back to interrupted state', error, {
        otterId: info.otterId,
        conversationId: info.conversationId,
      });
      try {
        const sysMsg = await this.deps.sendMessage.sendSystem(info.conversationId, buildCircuitBreakFailureMsg());
        emitEvent({ event: "system.message", data: { messageId: sysMsg.id, content: aggregateBody(sysMsg.segments), seq: sysMsg.sequenceNum } });
      } catch { /* ignore */ }
      await this.writeCircuitBreakEvent(info, { trigger: 'primary', failed: true, error: error.message }).catch(() => { /* non-fatal */ });
      return false;
    }

    /**
     * restart 成功即熔断成功：事件写入失败仅留痕、仍返回 true——
     * 若按失败处理会谎报"重启失败可手动重试"（上下文实际已清空），且新 session 无上限标记。
     * 二级预检的 startedAt 过滤兜底防循环（重启前的退化事件不属于新 session 生命周期）。
     */
    await this.writeCircuitBreakEvent(info, { newSessionId: session.id, trigger: 'primary' }).catch(err => {
      this.deps.logger.error('circuit_break event write failed after successful restart (marker missing, non-fatal)', err instanceof Error ? err : new Error(String(err)), {
        otterId: info.otterId,
        newSessionId: session.id,
      });
    });
    this.deps.logger.info('Circuit break restart executed', {
      otterId: info.otterId,
      conversationId: info.conversationId,
      newSessionId: session.id,
    });
    return true;
  }

  /**
   * F20260818cbkr 二级触发（invoke 前预检）：
   * 本 session 生命周期内、最近 2 个 turn 窗口 ≥2 次 degenerate 事件 → 先重启再执行本次 invoke。
   * 熔断创建的 session 不再触发（上限，防无限 restart 循环）；预检自身失败不阻塞 invoke（非致命）。
   */
  async maybeSecondaryCircuitBreak(otterId: string, conversationId: string): Promise<void> {
    try {
      const session = await this.deps.manageSession.getActiveSession(otterId);
      if (!session) return;
      if (await this.isCircuitBreakCreatedSession(otterId, session.id)) return;

      const inWindow = await this.countDegenerateInTurnWindow(otterId, session);
      if (inWindow.count < 2) return;

      const lastUserMsg = await this.deps.queryMessage.getLastMessageBySender(conversationId, 'user').catch(() => null);
      const lastUserMessage = lastUserMsg ? aggregateBody(lastUserMsg.segments) : '';
      const summary = lastUserMessage
        ? buildSecondaryCircuitBreakSummary({ lastUserMessage })
        : buildCircuitBreakFallbackSummary();
      const newSession = await this.deps.manageSession.restartSession(otterId, summary);
      await this.writeCircuitBreakEvent(
        { otterId, conversationId, failedMessageId: inWindow.firstMessageId },
        { newSessionId: newSession.id, trigger: 'secondary' },
      ).catch(err => {
        this.deps.logger.error('circuit_break event write failed after secondary restart (marker missing, non-fatal)', err instanceof Error ? err : new Error(String(err)), {
          otterId,
          newSessionId: newSession.id,
        });
      });
      this.deps.logger.info('Secondary circuit break executed', {
        otterId,
        conversationId,
        newSessionId: newSession.id,
        degenerateCount: inWindow.count,
      });
    } catch (err) {
      this.deps.logger.warn('Secondary circuit break check failed (non-fatal)', {
        otterId,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 统计本 session 生命周期内、最近 2 个 turn 窗口内的退化事件数（turn 经 messages.turn_id 推导，healing_events 无 turn 字段） */
  private async countDegenerateInTurnWindow(otterId: string, session: OtterSession): Promise<TurnWindowCount> {
    const events = await this.deps.healingRepo.findRecentByOtter(otterId, 'degenerate', 10);
    /** 只统计本 session 生命周期内的退化（重启前的旧事件属于已清空的上下文） */
    const recent = events.filter(e => e.createdAt >= session.startedAt);
    if (recent.length < 2) {
      return { count: recent.length, firstMessageId: recent[0]?.messageId ?? '' };
    }

    const turnIdByMessage = await this.mapMessageTurnIds(recent);
    /** turn 未知的消息不参与窗口：不同 turn 归并进同一 unknown 会造成假阳性，非致命优先不命中 */
    const known = recent.filter(ev => turnIdByMessage.has(ev.messageId));
    const orderedTurns: string[] = [];
    for (const ev of known) {
      const tid = turnIdByMessage.get(ev.messageId)!;
      if (!orderedTurns.includes(tid)) orderedTurns.push(tid);
    }
    if (orderedTurns.length === 0) {
      return { count: 0, firstMessageId: recent[0]?.messageId ?? '' };
    }
    const window = new Set(orderedTurns.slice(0, 2));
    const inWindow = known.filter(ev => window.has(turnIdByMessage.get(ev.messageId)!));
    return { count: inWindow.length, firstMessageId: inWindow[0]?.messageId ?? '' };
  }

  /** messageId → turnId 映射（一次查询；查询失败的消息不写入映射，即不参与窗口） */
  private async mapMessageTurnIds(recent: HealingEvent[]): Promise<Map<string, string>> {
    const turnIdByMessage = new Map<string, string>();
    for (const ev of recent) {
      if (turnIdByMessage.has(ev.messageId)) continue;
      const msg = await this.deps.queryMessage.getMessageById(ev.messageId).catch(() => null);
      if (msg?.turnId) turnIdByMessage.set(ev.messageId, msg.turnId);
    }
    return turnIdByMessage;
  }

  /** session 是否被 circuit_break 事件标记为熔断创建 */
  private async isCircuitBreakCreatedSession(otterId: string, sessionId: string): Promise<boolean> {
    const events = await this.deps.healingRepo.findRecentByOtter(otterId, 'circuit_break', 20);
    return events.some(e => {
      const ctx = e.context as { newSessionId?: string } | null;
      return ctx?.newSessionId === sessionId;
    });
  }

  /** 熔断前情摘要：原始消息 + 失败 turn 的工具调用序列；素材查询失败降级短摘要 */
  private async buildCircuitBreakSummaryText(info: CircuitBreakInfo): Promise<string> {
    try {
      const toolNames = await this.extractToolNames(info.failedMessageId);
      return buildCircuitBreakSummary({ originalUserMessage: info.originalUserMessage, toolNames });
    } catch {
      return buildCircuitBreakFallbackSummary();
    }
  }

  /** 从 message_events 提取失败消息的 tool_call 工具名序列（按事件顺序） */
  private async extractToolNames(messageId: string): Promise<string[]> {
    const events = await this.deps.queryMessage.getMessageEvents(messageId);
    const names: string[] = [];
    for (const evt of events) {
      if (evt.eventType !== 'assistant_toolcall') continue;
      const content = evt.payload?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === 'object' && 'name' in block && typeof block.name === 'string') {
          names.push(block.name);
        }
      }
    }
    return names;
  }

  /** circuit_break 事件写入（上限判定与二级触发防循环的数据源；失败仅留痕不阻塞） */
  private async writeCircuitBreakEvent(
    info: Pick<CircuitBreakInfo, 'otterId' | 'conversationId' | 'failedMessageId'>,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.recordHealingEvent({
      messageId: info.failedMessageId,
      conversationId: info.conversationId,
      otterId: info.otterId,
      errorType: 'circuit_break',
      severity: 'medium',
      description: '连续输出退化触发熔断重启（F20260818cbkr）',
      context,
    });
  }
}
