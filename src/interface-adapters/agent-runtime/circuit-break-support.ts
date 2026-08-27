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

  /**
   * F20260827he2f: healing_repo 健康探针——启动时调用一次，验证 DB 可达且表存在且列完整。
   * 失败仅 warn（不阻塞启动），但日志可作为「healing_events 写入盲区」的诊断入口。
   * Why: issue #508——熔断重启已发生但事件未落库，健康检查链路对此失明。
   * 根因是 healingRepo.create() 抛错被静默吞掉，无可观测信号。
   * 
   * F20260827he2f 二轮审视：原探针只测读路径（findOpen），无法检测写路径列缺失（introduced_by_pr）。
   * 此处增加写路径探针——尝试插入一条测试记录，失败时检查是否为列缺失错误。
   */
  async probeHealingRepo(): Promise<boolean> {
    try {
      // 读路径探针：验证表存在且 DB 可达
      await this.deps.healingRepo.findOpen(1);
      
      // 写路径探针：尝试插入一条测试记录，验证列完整性
      const testEvent: HealingEvent = {
        id: crypto.randomUUID(),
        messageId: 'probe-test',
        conversationId: 'probe-test',
        otterId: 'probe-test',
        errorType: 'other',
        severity: 'low',
        description: '健康探针测试记录（F20260827he2f）',
        suggestion: '',
        context: null,
        status: 'open',
        resolution: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      
      try {
        await this.deps.healingRepo.create(testEvent);
        // 插入成功，立即删除测试记录（回滚）
        // 注意：这里无法直接删除，因为 repository 没有 delete 方法
        // 但测试记录会被 autoStaleDismiss 清理（低严重度，7天后自动清理）
        return true;
      } catch (writeErr) {
        // 写路径失败，检查是否为列缺失错误
        const errMessage = writeErr instanceof Error ? writeErr.message : String(writeErr);
        if (errMessage.includes('no such column') || errMessage.includes('has no column')) {
          this.deps.logger.error('healing_repo write probe failed — missing column in healing_events table',
            writeErr instanceof Error ? writeErr : new Error(String(writeErr)),
            { 
              component: 'CircuitBreakSupport', 
              check: 'healing_repo_write_probe',
              detail: 'likely introduced_by_pr column missing (PR #386 migration not applied to existing DB)',
            },
          );
          return false;
        }
        // 其他写入错误（如约束冲突）忽略，表结构完整
        this.deps.logger.debug('healing_repo write probe non-fatal error (table structure OK)', {
          error: errMessage,
        });
        return true;
      }
    } catch (err) {
      // 读路径失败
      this.deps.logger.error('healing_repo probe failed — circuit breaker events will NOT be persisted',
        err instanceof Error ? err : new Error(String(err)),
        { component: 'CircuitBreakSupport', check: 'healing_repo_probe' },
      );
      return false;
    }
  }

  /** degenerate guard 触发点回调：组装完整 HealingEvent 写库 */
  async recordHealingEvent(input: HealingEventInput): Promise<void> {
    try {
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
    } catch (err) {
      // F20260827he2f: 记录完整上下文，让健康检查链路可观测
      this.deps.logger.error('healing_event write FAILED — circuit breaker data source degraded',
        err instanceof Error ? err : new Error(String(err)),
        {
          component: 'CircuitBreakSupport',
          errorType: input.errorType,
          otterId: input.otterId,
          messageId: input.messageId,
          conversationId: input.conversationId,
        },
      );
      throw err; // 重新抛出：调用方需要知道写入失败
    }
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
      // F20260827he2f: error 级别 + 完整上下文——让健康检查链路可观测
      this.deps.logger.error('circuit_break event write failed after successful restart — healing_events data source degraded',
        err instanceof Error ? err : new Error(String(err)),
        {
          component: 'CircuitBreakSupport',
          otterId: info.otterId,
          newSessionId: session.id,
          failedMessageId: info.failedMessageId,
          conversationId: info.conversationId,
        },
      );
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

      /** senderType 口径（sender_id 字面量仅 web 路径成立，scheduler/桥接路径会落空） */
      const userMsgs = await this.deps.queryMessage.getMessages(conversationId, { senderType: 'user', limit: 1 }).catch(() => []);
      const lastUserMessage = userMsgs[0] ? aggregateBody(userMsgs[0].segments) : '';
      const summary = lastUserMessage
        ? buildSecondaryCircuitBreakSummary({ lastUserMessage })
        : buildCircuitBreakFallbackSummary();
      const newSession = await this.deps.manageSession.restartSession(otterId, summary);
      await this.writeCircuitBreakEvent(
        { otterId, conversationId, failedMessageId: inWindow.firstMessageId },
        { newSessionId: newSession.id, trigger: 'secondary' },
      ).catch(err => {
        // F20260827he2f: error 级别 + 完整上下文
        this.deps.logger.error('circuit_break event write failed after secondary restart — healing_events data source degraded',
          err instanceof Error ? err : new Error(String(err)),
          {
            component: 'CircuitBreakSupport',
            otterId,
            newSessionId: newSession.id,
            conversationId,
            trigger: 'secondary',
          },
        );
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

  /**
   * F20260824srst：当前 active session 是否由自重启创建（self_restart 事件 context.newSessionId 指向它）。
   * Why 复用 isCircuitBreakCreatedSession 模式：self_restart 与 circuit_break 的防循环机制同构，
   * 都是 healing_events + context.newSessionId 标记新 session，区别仅在 errorType 语义。
   */
  async isSessionSelfRestartCreated(otterId: string): Promise<boolean> {
    const session = await this.deps.manageSession.getActiveSession(otterId).catch(() => null);
    if (!session) return false;
    const events = await this.deps.healingRepo.findRecentByOtter(otterId, 'self_restart', 20);
    return events.some(e => {
      const ctx = e.context as { newSessionId?: string } | null;
      return ctx?.newSessionId === session.id;
    });
  }

  /**
   * F20260824srst：写入 self_restart healing 事件（上限判定的数据源）。
   * 复用 writeCircuitBreakEvent 模式，区别仅在 errorType 和描述语义。
   */
  async writeSelfRestartEvent(otterId: string, conversationId: string, newSessionId: string, messageId: string): Promise<void> {
    try {
      await this.recordHealingEvent({
        messageId,
        conversationId,
        otterId,
        errorType: 'self_restart',
        severity: 'medium',
        description: '海獭自重启执行（F20260824srst）',
        context: { newSessionId },
      });
    } catch (err) {
      // F20260827he2f: error 级别 + 完整上下文
      this.deps.logger.error('self_restart event write failed — healing_events data source degraded',
        err instanceof Error ? err : new Error(String(err)),
        {
          component: 'CircuitBreakSupport',
          errorType: 'self_restart',
          otterId,
          newSessionId,
          messageId,
          conversationId,
        },
      );
      throw err;
    }
  }

  /** 熔断前情摘要：原始消息 + 失败 turn 的工具调用序列；素材查询失败降级短摘要 */
  private async buildCircuitBreakSummaryText(info: CircuitBreakInfo): Promise<string> {
    try {
      /**
       * 工作进度主要在首条消息（degenerate retry 前的 attempt）——retry 创建的第二条消息
       * 往往刚起步就退化。合并两条消息的事件，按发生顺序还原工具序列。
       */
      const messageIds = info.firstMessageId && info.firstMessageId !== info.failedMessageId
        ? [info.firstMessageId, info.failedMessageId]
        : [info.failedMessageId];
      const toolNames: string[] = [];
      for (const mid of messageIds) {
        toolNames.push(...await this.extractToolNames(mid));
      }
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
