/**
 * F20260827helf：healing_events 熔断落库集成测试
 *
 * Why: issue #508——熔断重启已发生但 healing events 未落库，健康检查链路对此失明。
 * 本测试用真实 SQLite（非 mock）验证：
 * 1. degenerate + circuit_break 事件确实在 DB 中持久化
 * 2. 健康探针（probeHealingRepo）能检测 DB 可达性
 * 3. DB 不可达时事件写入失败有可观测信号（error 日志）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../../helpers/db";
import { SqliteHealingEventRepository } from "@frameworks/db/healing/sqlite-healing-event-repository";
import { CircuitBreakSupport } from "@interface-adapters/agent-runtime/circuit-break-support";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { HealingEventInput } from "@usecases/conversation/agent-turn-orchestrator/types";
import type Database from "better-sqlite3";

function createCircuitBreakSupport(db: Database.Database) {
  const healingRepo = new SqliteHealingEventRepository(db);
  const logEntries: Array<{ level: string; message: string; context?: unknown }> = [];
  const logger = {
    info: (msg: string, ctx?: unknown) => logEntries.push({ level: 'info', message: msg, context: ctx }),
    warn: (msg: string, ctx?: unknown) => logEntries.push({ level: 'warn', message: msg, context: ctx }),
    error: (msg: string, err?: Error, ctx?: unknown) => logEntries.push({ level: 'error', message: msg, context: ctx }),
    debug: () => {},
    flush: () => {},
  } as any;
  const manageSession = {
    getActiveSession: async () => null,
    restartSession: async () => ({ id: 'new-sess', otterId: 'otter-1', startedAt: new Date().toISOString() }),
  } as unknown as ManageSession;
  const queryMessage = {
    getMessageById: async () => null,
    getMessages: async () => [],
  } as unknown as QueryMessage;
  const sendMessage = {
    sendSystem: async () => ({ id: 'sys-1', segments: [], sequenceNum: 1 }),
  } as unknown as SendMessage;

  return {
    support: new CircuitBreakSupport({ manageSession, queryMessage, sendMessage, healingRepo, logger }),
    healingRepo,
    logEntries,
    logger,
  };
}

describe("F20260827helf: healing_events 熔断落库集成（真实 SQLite）", () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("probeHealingRepo: DB 可达时返回 true", async () => {
    const { support } = createCircuitBreakSupport(db);
    const result = await support.probeHealingRepo();
    expect(result).toBe(true);
  });

  it("probeHealingRepo: DB 不可达时返回 false 并记录 error 日志", async () => {
    const { support, logEntries } = createCircuitBreakSupport(db);
    // 关闭 DB 模拟不可达
    db.close();
    const result = await support.probeHealingRepo();
    expect(result).toBe(false);
    expect(logEntries.some(e => e.level === 'error' && e.message.includes('probe failed'))).toBe(true);
  });

  it("recordHealingEvent: degenerate 事件确实在 DB 中持久化", async () => {
    const { support, healingRepo } = createCircuitBreakSupport(db);
    const input: HealingEventInput = {
      messageId: "msg-deg-1",
      conversationId: "conv-1",
      otterId: "otter-1",
      errorType: "degenerate",
      severity: "high",
      description: "检测到输出异常重复",
      suggestion: "连续退化将触发熔断重启",
      context: { retryCount: 0, toolCallCount: 5 },
    };

    await support.recordHealingEvent(input);

    // 验证在 DB 中持久化
    const events = await healingRepo.findByConversation("conv-1");
    expect(events).toHaveLength(1);
    expect(events[0].errorType).toBe("degenerate");
    expect(events[0].messageId).toBe("msg-deg-1");
    expect(events[0].otterId).toBe("otter-1");
    expect(events[0].status).toBe("open");
  });

  it("recordHealingEvent: circuit_break 事件确实在 DB 中持久化", async () => {
    const { support, healingRepo } = createCircuitBreakSupport(db);
    const input: HealingEventInput = {
      messageId: "msg-cb-1",
      conversationId: "conv-1",
      otterId: "otter-1",
      errorType: "circuit_break",
      severity: "medium",
      description: "连续输出退化触发熔断重启（F20260818cbkr）",
      context: { newSessionId: "sess-new", trigger: "primary" },
    };

    await support.recordHealingEvent(input);

    // 验证在 DB 中持久化
    const events = await healingRepo.findByConversation("conv-1");
    expect(events).toHaveLength(1);
    expect(events[0].errorType).toBe("circuit_break");
    expect(events[0].context).toEqual({ newSessionId: "sess-new", trigger: "primary" });
  });

  it("degenerate + circuit_break 配对落库（熔断完整链路）", async () => {
    const { support, healingRepo } = createCircuitBreakSupport(db);

    // 1. 记录 degenerate 事件
    await support.recordHealingEvent({
      messageId: "msg-deg-1",
      conversationId: "conv-1",
      otterId: "otter-1",
      errorType: "degenerate",
      severity: "high",
      description: "检测到输出异常重复（retry=0）",
      context: { retryCount: 0 },
    });

    // 2. 记录 circuit_break 事件（模拟 restart 成功后）
    await support.recordHealingEvent({
      messageId: "msg-deg-2",
      conversationId: "conv-1",
      otterId: "otter-1",
      errorType: "circuit_break",
      severity: "medium",
      description: "连续输出退化触发熔断重启（F20260818cbkr）",
      context: { newSessionId: "sess-new", trigger: "primary" },
    });

    // 验证配对落库
    const allEvents = await healingRepo.findByConversation("conv-1");
    expect(allEvents).toHaveLength(2);

    const degenerate = allEvents.filter(e => e.errorType === "degenerate");
    const circuitBreaks = allEvents.filter(e => e.errorType === "circuit_break");
    expect(degenerate).toHaveLength(1);
    expect(circuitBreaks).toHaveLength(1);
    expect((circuitBreaks[0].context as { newSessionId?: string })?.newSessionId).toBe("sess-new");
  });

  it("recordHealingEvent: DB 不可达时抛错并记录 error 日志", async () => {
    const { support, logEntries } = createCircuitBreakSupport(db);
    // 关闭 DB 模拟不可达
    db.close();

    const input: HealingEventInput = {
      messageId: "msg-fail-1",
      conversationId: "conv-1",
      otterId: "otter-1",
      errorType: "degenerate",
      severity: "high",
      description: "test",
    };

    await expect(support.recordHealingEvent(input)).rejects.toThrow();
    expect(logEntries.some(e => e.level === 'error' && e.message.includes('write FAILED'))).toBe(true);
  });
});
