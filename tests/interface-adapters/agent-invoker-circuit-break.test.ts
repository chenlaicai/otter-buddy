/**
 * F20260818cbkr：连续退化 → 重启獭生熔断
 *
 * 覆盖设计文档验收场景 AT-1~AT-4 + 熔断上限 + 熔断执行失败降级。
 * 熔断依赖 healing_events 状态载体，测试均注入 healingRepo mock（生产恒注入）。
 */
import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingEvent } from "@entities/healing/healing-event";
import type { OtterSession } from "@entities/otter/otter-session";
import type { Message } from "@entities/conversation/message";
import { createTestLogger } from "../helpers/logger";

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-old", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-08-01T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null,
    ...overrides,
  };
}

/** 内存 healing repo mock：记录 create，支持 findRecentByOtter */
function mockHealingRepo(seed: HealingEvent[] = []) {
  const events = [...seed];
  return {
    events,
    repo: {
      create: async (event: HealingEvent) => { events.push(event); },
      findRecentByOtter: async (otterId: string, errorType: string, limit = 10) =>
        events.filter(e => e.otterId === otterId && e.errorType === errorType).slice(-limit).reverse(),
    } as unknown as HealingEventRepository,
  };
}

function seedEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
  return {
    id: `he-${Math.random().toString(36).slice(2)}`,
    messageId: "msg-deg-1",
    conversationId: "conv-1",
    otterId: "otter-1",
    errorType: "degenerate",
    severity: "high",
    description: "检测到输出异常重复",
    suggestion: "",
    context: null,
    status: "open",
    resolution: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...overrides,
  };
}

/** SendMessage mock：记录 fail/abort/sendSystem，可注入 restartSession 后新消息 */
function mockSendMessage() {
  const failCalls: Array<{ id: string; body: string }> = [];
  const abortCalls: Array<{ id: string; body: string }> = [];
  const sendSystemBodies: string[] = [];
  let seq = 0;
  const start = async (): Promise<Message> => ({
    id: `msg-${++seq}`, conversationId: "conv-1", turnId: "turn-1",
    senderType: "otter", senderId: "otter-1", talkingStonePassedTo: null,
    status: "streaming", segments: [], sequenceNum: seq,
    contextTokens: null, contextTokensMax: null, source: "web",
    createdAt: new Date().toISOString(), completedAt: null,
  });
  return {
    start,
    complete: async (id: string) => {
      const turnClose = { closed: true, aggregatedTargets: ["user-1"] };
      return { message: { id }, turnClose };
    },
    fail: async (id: string, body?: string) => { failCalls.push({ id, body: body ?? "" }); },
    abort: async (id: string, input: { body: string }) => { abortCalls.push({ id, body: input.body }); },
    appendEvent: async () => ({}),
    sendSystem: async (_c: string, body: string) => {
      sendSystemBodies.push(body);
      return {
        id: `sys-${++seq}`, conversationId: "conv-1", turnId: "turn-1",
        senderType: "system" as const, senderId: "system", talkingStonePassedTo: null,
        status: "completed" as const,
        segments: [{ id: `seg-${++seq}`, messageId: `sys-${seq}`, body, sequenceNum: 0, createdAt: new Date().toISOString() }],
        sequenceNum: seq, contextTokens: null, contextTokensMax: null, source: "web" as const,
        createdAt: new Date().toISOString(), completedAt: null,
      };
    },
    updateTokenUsage: async () => ({}),
    prepareForRetry: async (id: string) => ({ id }),
    _failCalls: failCalls,
    _abortCalls: abortCalls,
    _sendSystemBodies: sendSystemBodies,
  } as unknown as SendMessage & {
    _failCalls: typeof failCalls; _abortCalls: typeof abortCalls; _sendSystemBodies: typeof sendSystemBodies;
  };
}

/** SdkInvokePort mock：前 N 次 degenerate，之后成功；记录每次 invoke 的 dynamicContext */
function mockAgentInvoke(degenerateTimes: number) {
  let invokeCount = 0;
  const contexts: Array<{ sessionSummary?: string } | undefined> = [];
  const mock: SdkInvokePort & { _contexts: typeof contexts; _count: () => number } = {
    invoke: async (_otterId: string, _message: string, opts?: { dynamicContext?: { sessionSummary?: string } }) => {
      invokeCount++;
      contexts.push(opts?.dynamicContext);
      if (invokeCount <= degenerateTimes) return { text: "" };
      return { text: "正常输出" };
    },
    abort: () => {},
    getToolCallCount: () => 0,
    getInternalAbortReason: () => (invokeCount <= degenerateTimes ? "degenerate_output" : undefined),
    _contexts: contexts,
    _count: () => invokeCount,
  };
  return mock;
}

/** ManageSession mock：active session 可变，restart 归档旧的并切到新 session（带 summary） */
function mockManageSession(initial: OtterSession) {
  let active: OtterSession | null = initial;
  const restartCalls: Array<{ otterId: string; summary?: string }> = [];
  const failRestart = { value: false as unknown as Error | false };
  return {
    restartCalls,
    failRestart,
    mock: {
      getActiveSession: async () => active,
      createSession: async (otterId: string) => makeSession({ id: "sess-backfill", otterId }),
      restartSession: async (otterId: string, summary?: string) => {
        if (failRestart.value) throw failRestart.value;
        restartCalls.push({ otterId, summary });
        /**
         * startedAt 取重启时刻。生产时序：restartSession 需经 archiveSession 多次 DB 往返，
         * 新 session startedAt 必然严格晚于退化事件 createdAt（重启前的退化不属于新 session 生命周期）。
         * mock 无真实 IO，+1s 模拟该时序差。
         */
        active = makeSession({ id: "sess-new", otterId, summary: summary ?? null, previousSessionId: initial.id, startedAt: new Date(Date.now() + 1000).toISOString() });
        return active;
      },
    } as unknown as ManageSession,
  };
}

function mockQueryMessage(overrides?: {
  events?: Array<{ eventType: string; payload: Record<string, unknown> }>;
  turnByMessage?: Record<string, string>;
  speakingAfter?: number;
}): QueryMessage {
  let queryCount = 0;
  return {
    getMessageById: async (id: string) => {
      queryCount++;
      const status = overrides && overrides.speakingAfter !== undefined && queryCount > overrides.speakingAfter
        ? "speaking" : "streaming";
      return {
        id, status, body: null,
        turnId: overrides?.turnByMessage?.[id] ?? "turn-1",
      };
    },
    getMessageEvents: async (messageId: string) => (overrides?.events ?? [])
      .filter(e => (e as { messageIds?: string[] }).messageIds?.includes(messageId) !== false)
      .map((e, i) => ({
        id: `ev-${i}`, messageId, eventType: (e as { eventType: string }).eventType, payload: (e as { payload: Record<string, unknown> }).payload,
        sequenceNum: i, createdAt: new Date().toISOString(),
      })),
    /** senderType 口径（与生产一致,sender_id 字面量仅 web 路径成立） */
    getMessages: async (_conversationId: string, options: { senderType?: string; limit?: number }) => {
      if (options.senderType !== "user") return [];
      return [{
        id: "msg-user-1", conversationId: "conv-1", turnId: "turn-1",
        senderType: "user" as const, senderId: "user", talkingStonePassedTo: null,
        status: "completed" as const,
        segments: [{ id: "seg-user-1", messageId: "msg-user-1", body: "继续实现小獭闲置预警", sequenceNum: 0, createdAt: new Date().toISOString() }],
        sequenceNum: 1, contextTokens: null, contextTokensMax: null, source: "web" as const,
        createdAt: new Date().toISOString(), completedAt: null,
      }];
    },
  } as unknown as QueryMessage;
}

const queryOtter: QueryOtter = { getById: async () => ({ id: "otter-1", name: "大獭", type: "main" }) } as unknown as QueryOtter;

describe("AgentInvoker — 连续退化熔断 (F20260818cbkr)", () => {
  it("AT-1/AT-3：degenerate retry 再退化 → 熔断重启 + 全新 invoke（含前情摘要），自动恢复", async () => {
    const msg = mockSendMessage();
    const healing = mockHealingRepo();
    const session = mockManageSession(makeSession());
    const invoke = mockAgentInvoke(2); // 前两次退化，第三次成功
    /** 工具事件只挂在 retry 前的首条消息(msg-1)——摘要必须合并首条消息的工作进度 */
    const toolEvents = [
      { eventType: "assistant_text", payload: { content: [] }, messageIds: ["msg-1"] },
      { eventType: "assistant_toolcall", payload: { content: [{ type: "toolCall", name: "read" }, { type: "toolCall", name: "write" }] }, messageIds: ["msg-1"] },
    ];
    const qm = mockQueryMessage({ events: toolEvents, speakingAfter: 2 });
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(), undefined, undefined, undefined, undefined,
      healing.repo,
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "实现小獭闲置预警系统", senderId: "user-1",
    });

    // 熔断重启执行一次，前情摘要含原始任务与工具序列（AT-3）
    expect(session.restartCalls).toHaveLength(1);
    const summary = session.restartCalls[0].summary ?? "";
    expect(summary).toContain("熔断重启");
    expect(summary).toContain("实现小獭闲置预警系统");
    /** 工具序列来自 retry 前首条消息(retry 消息无事件),验证 firstMessageId 合并 */
    expect(summary).toContain("read");
    expect(summary).toContain("write");

    // 消息序列：自我纠正 fail → 熔断 fail；系统消息含熔断说明；无 abort
    expect(msg._failCalls.map(f => f.body)).toContainEqual(expect.stringContaining("自我纠正"));
    expect(msg._failCalls.map(f => f.body)).toContainEqual(expect.stringContaining("熔断重启獭生"));
    expect(msg._sendSystemBodies).toContainEqual(expect.stringContaining("已重启獭生"));
    expect(msg._abortCalls).toHaveLength(0);

    // healing_events：2 条 degenerate（两次退化各一条）+ 1 条 circuit_break（关联新 session）
    const degenerate = healing.events.filter(e => e.errorType === "degenerate");
    const circuitBreaks = healing.events.filter(e => e.errorType === "circuit_break");
    expect(degenerate).toHaveLength(2);
    expect(circuitBreaks).toHaveLength(1);
    expect((circuitBreaks[0].context as { newSessionId?: string })?.newSessionId).toBe("sess-new");

    // 全新 invoke：第 3 次调用的 dynamicContext 携带新 session 的前情摘要
    expect(invoke._count()).toBe(3);
    expect(invoke._contexts[2]?.sessionSummary).toContain("实现小獭闲置预警系统");

    // 最终成功返回（全新 invoke 的消息完成）
    expect(result.messageId).toBeTruthy();
  });

  it("AT-2 熔断上限：session 已由熔断创建再退化 → abort 终态，不再 restart", async () => {
    const msg = mockSendMessage();
    /** 当前 active session 正是熔断创建的 sess-new */
    const healing = mockHealingRepo([
      seedEvent({ errorType: "circuit_break", context: { newSessionId: "sess-new" } }),
    ]);
    const session = mockManageSession(makeSession({ id: "sess-new" }));
    const invoke = mockAgentInvoke(99); // 永远退化
    const qm = mockQueryMessage({ speakingAfter: Infinity });
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(), undefined, undefined, undefined, undefined,
      healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(session.restartCalls).toHaveLength(0);
    expect(msg._abortCalls).toHaveLength(1);
    expect(msg._abortCalls[0].body).toContain("异常重复");
    // 熔断 fail 文案不应出现（走 abort 终态而非熔断）
    expect(msg._failCalls.map(f => f.body)).not.toContainEqual(expect.stringContaining("熔断重启獭生"));
  });

  it("AT-4 二级触发：invoke 前预检命中（本 session 内 2 turn 各 1 次退化）→ 先 restart 再 invoke", async () => {
    const msg = mockSendMessage();
    const now = new Date().toISOString();
    const healing = mockHealingRepo([
      seedEvent({ messageId: "msg-deg-1", createdAt: now }),
      seedEvent({ messageId: "msg-deg-2", createdAt: now }),
    ]);
    const session = mockManageSession(makeSession({ startedAt: "2026-08-01T00:00:00Z" }));
    const invoke = mockAgentInvoke(0); // 直接成功
    const qm = mockQueryMessage({
      turnByMessage: { "msg-deg-1": "turn-1", "msg-deg-2": "turn-2" },
      speakingAfter: 0,
    });
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(), undefined, undefined, undefined, undefined,
      healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(session.restartCalls).toHaveLength(1);
    expect(session.restartCalls[0].summary).toContain("二级熔断重启");
    expect(session.restartCalls[0].summary).toContain("继续实现小獭闲置预警");
    // restart 在 invoke 前执行，invoke 的 context 携带二级摘要
    expect(invoke._count()).toBe(1);
    expect(invoke._contexts[0]?.sessionSummary).toContain("二级熔断重启");
    expect(msg._abortCalls).toHaveLength(0);
  });

  it("二级触发不命中：退化事件跨 session（重启前旧事件）不触发", async () => {
    const msg = mockSendMessage();
    const healing = mockHealingRepo([
      seedEvent({ messageId: "msg-deg-1", createdAt: "2026-07-01T00:00:00Z" }),
      seedEvent({ messageId: "msg-deg-2", createdAt: "2026-07-01T00:00:01Z" }),
    ]);
    const session = mockManageSession(makeSession({ startedAt: "2026-08-01T00:00:00Z" }));
    const invoke = mockAgentInvoke(0);
    const qm = mockQueryMessage({ speakingAfter: 0 });
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(), undefined, undefined, undefined, undefined,
      healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    expect(session.restartCalls).toHaveLength(0);
    expect(invoke._count()).toBe(1);
  });

  it("熔断执行失败降级：restartSession 抛错 → 系统说明 + circuit_break 留痕，不再 invoke", async () => {
    const msg = mockSendMessage();
    const healing = mockHealingRepo();
    const session = mockManageSession(makeSession());
    session.failRestart.value = new Error("archive failed: DB locked");
    const invoke = mockAgentInvoke(2);
    const qm = mockQueryMessage({ speakingAfter: Infinity });
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(), undefined, undefined, undefined, undefined,
      healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    // 降级：熔断失败说明 + 留痕；不再发起全新 invoke（共 2 次调用：两次退化）
    expect(msg._sendSystemBodies).toContainEqual(expect.stringContaining("熔断重启执行失败"));
    const circuitBreaks = healing.events.filter(e => e.errorType === "circuit_break");
    expect(circuitBreaks).toHaveLength(1);
    expect((circuitBreaks[0].context as { failed?: boolean })?.failed).toBe(true);
    expect(invoke._count()).toBe(2);
  });

  it("叠加场景：二级预检重启后本 invoke 再连续退化 → 上限 abort，不再二次 restart", async () => {
    const msg = mockSendMessage();
    const now = new Date().toISOString();
    /** 预置本 session 内 2 次退化（触发二级预检） */
    const healing = mockHealingRepo([
      seedEvent({ messageId: "msg-deg-1", createdAt: now }),
      seedEvent({ messageId: "msg-deg-2", createdAt: now }),
    ]);
    const session = mockManageSession(makeSession({ startedAt: "2026-08-01T00:00:00Z" }));
    const invoke = mockAgentInvoke(99); // 预检重启后仍持续退化
    const qm = mockQueryMessage({
      turnByMessage: { "msg-deg-1": "turn-1", "msg-deg-2": "turn-2" },
      speakingAfter: Infinity,
    });
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(), undefined, undefined, undefined, undefined,
      healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    /** 二级预检 restart 1 次；随后 invoke 内退化→retry→再退化→一级熔断查得 session 由熔断创建→上限 abort。总 restart 恰好 1 次，无循环。 */
    expect(session.restartCalls).toHaveLength(1);
    expect(session.restartCalls[0].summary).toContain("二级熔断重启");
    expect(msg._abortCalls).toHaveLength(1);
    expect(msg._abortCalls[0].body).toContain("异常重复");
  });

  it("半成功路径（S1）：restart 成功但 circuit_break 事件写入失败 → 仍按熔断成功续跑，不发失败文案", async () => {
    const msg = mockSendMessage();
    const healing = mockHealingRepo();
    /** 仅 circuit_break 类型写入抛错（degenerate 事件正常落库） */
    (healing.repo as unknown as { create: (e: HealingEvent) => Promise<void> }).create = async (e: HealingEvent) => {
      if (e.errorType === "circuit_break") throw new Error("healing db locked");
      healing.events.push(e);
    };
    const session = mockManageSession(makeSession());
    const invoke = mockAgentInvoke(2);
    const qm = mockQueryMessage({ speakingAfter: 2 });
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(), undefined, undefined, undefined, undefined,
      healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    /** restart 真实发生，按成功处理：全新 invoke 发生、无"熔断重启执行失败"误导文案 */
    expect(session.restartCalls).toHaveLength(1);
    expect(invoke._count()).toBe(3);
    expect(msg._sendSystemBodies).not.toContainEqual(expect.stringContaining("熔断重启执行失败"));
    expect(msg._abortCalls).toHaveLength(0);
  });

  it("healingRepo 未注入（降级配置）：二次退化走旧 abort 语义，不熔断", async () => {
    const msg = mockSendMessage();
    const session = mockManageSession(makeSession());
    const invoke = mockAgentInvoke(99);
    const qm = mockQueryMessage({ speakingAfter: Infinity });
    const invoker = new AgentInvoker(
      invoke, msg, qm, session.mock, queryOtter, createTestLogger(),
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    expect(session.restartCalls).toHaveLength(0);
    expect(msg._abortCalls).toHaveLength(1);
  });
});
