/**
 * #731：bash 守卫二拦终态自动回发控制信号（guard bounce）
 *
 * 集成级测试（AgentInvoker 全链路，借鉴 agent-invoker-circuit-break.test.ts 模式）：
 * - GB-1 二拦终态 → 不再 aborted，自动回发：fail + sendSystem(带原因+引导) + 新消息重整
 * - GB-2 回发后自纠成功（不再撞守卫）→ 任务闭环，无需人工拉起（事故 C 形态不复现）
 * - GB-3 有界防护：滑窗内已回发 3 次 → 停止回发，abort 终态 + 升级系统消息 + healing high
 * - GB-4 计数查询失败（台账失明）→ fail-closed 升级（不无限回发）
 * - GB-5 旧消息 fail 后 sdk session 已 abort（dead message 不僵尸运行）
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

const GUARD_REASON = "bash_safety:bash 命令包含针对主进程 PID 的终止命令。主进程是海獭运行环境，任何情况下不得终止。";

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-09-01T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null,
    ...overrides,
  };
}

/** 内存 healing repo mock：记录 create，支持 findRecentByOtter（含滑窗过滤语义靠 seed 控） */
function mockHealingRepo(seed: HealingEvent[] = [], opts?: { failQuery?: boolean }) {
  const events = [...seed];
  return {
    events,
    repo: {
      create: async (event: HealingEvent) => { events.push(event); },
      findRecentByOtter: async (otterId: string, errorType: string, limit = 10) => {
        if (opts?.failQuery) throw new Error("db unavailable");
        return events
          .filter(e => e.otterId === otterId && e.errorType === errorType)
          .slice(-limit)
          .reverse();
      },
    } as unknown as HealingEventRepository,
  };
}

function seedBounceEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
  return {
    id: `gb-${Math.random().toString(36).slice(2)}`,
    messageId: "msg-seed",
    conversationId: "conv-1",
    otterId: "otter-1",
    errorType: "guard_intercept",
    severity: "medium",
    description: "bash 守卫二拦终态自动回发控制信号（seed）",
    suggestion: "",
    context: { bounce: true },
    status: "open",
    resolution: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...overrides,
  };
}

/** SendMessage mock：记录 fail/abort/sendSystem；complete 返回 aggregatedTargets=['user-1']（链正常交棒）；
 *  start 捕获入参（2026-09-04 幽灵 sender 修复回归锚：断言重试新消息 speaker=otterId 非 senderId） */
function mockSendMessage() {
  const failCalls: Array<{ id: string; body: string }> = [];
  const abortCalls: Array<{ id: string; body: string }> = [];
  const sendSystemBodies: string[] = [];
  const startedMessages: string[] = [];
  const startInputs: Array<{ senderId: string; talkingStonePassedTo: string[] }> = [];
  let seq = 0;
  const start = async (input: { conversationId: string; senderId: string; talkingStonePassedTo: string[] }): Promise<Message> => {
    const id = `msg-${++seq}`;
    startedMessages.push(id);
    startInputs.push({ senderId: input.senderId, talkingStonePassedTo: [...input.talkingStonePassedTo] });
    return {
      id, conversationId: "conv-1", turnId: "turn-1",
      senderType: "otter", senderId: "otter-1", talkingStonePassedTo: null,
      status: "streaming", segments: [], sequenceNum: seq,
      contextTokens: null, contextTokensMax: null, source: "web",
      senderName: "Test Otter",
      createdAt: new Date().toISOString(), completedAt: null,
    };
  };
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
    _startedMessages: startedMessages,
    _startInputs: startInputs,
  } as unknown as SendMessage & {
    _failCalls: typeof failCalls; _abortCalls: typeof abortCalls;
    _sendSystemBodies: typeof sendSystemBodies; _startedMessages: typeof startedMessages;
    _startInputs: typeof startInputs;
  };
}

/**
 * SdkInvokePort mock：bash_safety 场景脚本驱动。
 * script 元素：{ guard: n } = 接下来 n 次 invoke 返回 bash_safety 终态（内部 abort reason），
 * 之后 { done: true } 正常完成。getInternalAbortReason 与 invoke 计数联动。
 */
function mockAgentInvoke(script: Array<{ guard: number } | { done: true }>) {
  let invokeCount = 0;
  const contexts: Array<string | undefined> = [];
  const aborts: string[] = [];
  /** 按 script 展开每步的终态 reason */
  const steps: Array<string | undefined> = [];
  for (const step of script) {
    if ("guard" in step) for (let i = 0; i < step.guard; i++) steps.push(GUARD_REASON);
    else steps.push(undefined);
  }
  const mock: SdkInvokePort & { _contexts: typeof contexts; _aborts: string[]; _count: () => number } = {
    invoke: async (_otterId: string, message: string) => {
      invokeCount++;
      contexts.push(message);
      if (steps[invokeCount - 1]) return { text: "" };
      return { text: "正常输出" };
    },
    abort: () => { aborts.push(`abort-${aborts.length + 1}`); },
    getToolCallCount: () => 0,
    getInternalAbortReason: () => steps[invokeCount - 1],
    _contexts: contexts,
    _aborts: aborts,
    _count: () => invokeCount,
  };
  return mock;
}

function mockQueryMessage(): QueryMessage {
  let queryCount = 0;
  return {
    // msg-1（原消息）恒 streaming（守卫拦截从未走到 speak）；后续消息首次查询后 speaking
    // （模拟 LLM 已调 speak：真实流由 sendMessage.startSpeaking 驱动，mock 里用查询次数近似）
    getMessageById: async (id: string) => {
      queryCount++;
      const status = id === "msg-1" || queryCount <= 1 ? "streaming" : "speaking";
      return { id, status, body: null, turnId: "turn-1" };
    },
    getMessageEvents: async () => [],
    getMessages: async () => [],
  } as unknown as QueryMessage;
}

const mockManageSession = {
  getActiveSession: async () => makeSession(),
  restartSession: async () => makeSession({ id: "sess-new" }),
} as unknown as ManageSession;

const queryOtter: QueryOtter = { getById: async () => ({ id: "otter-1", name: "大獭", type: "main" }) } as unknown as QueryOtter;

describe("AgentInvoker — bash 守卫二拦终态自动回发控制信号 (#731)", () => {
  it("GB-1/GB-2：二拦终态 → 自动回发（fail+sendSystem 带因+新消息）→ 回发后自纠成功闭环", async () => {
    const msg = mockSendMessage();
    const healing = mockHealingRepo();
    // 脚本：1 撞（首拦重试）→ 1 撞（二拦终态 → bounce）→ done（回发后自纠成功）
    const invoke = mockAgentInvoke([{ guard: 2 }, { done: true }]);
    const invoker = new AgentInvoker(
      invoke, msg, mockQueryMessage(), mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // 二拦终态不再 aborted：行动权不悬空
    expect(msg._abortCalls).toHaveLength(0);
    // 旧消息 fail 过渡：auto-retry 一次 + bounce 一次（后续 no_yield 兜底属 mock 环境噪声，不计）
    const bounceFails = msg._failCalls.filter(f => f.body.includes("自动回发控制信号"));
    expect(bounceFails).toHaveLength(1);
    // bounce sendSystem：含拦截原因透传 + 回发进度 + 四要素引导（无 restart 出口）
    const bounceMsg = msg._sendSystemBodies.find(b => b.includes("自动回发控制信号"));
    expect(bounceMsg).toBeTruthy();
    expect(bounceMsg).toContain("第 1/3 次");
    expect(bounceMsg).toContain("主进程");
    expect(bounceMsg).toContain("worktree");
    expect(bounceMsg).toContain("不要重复原命令");
    expect(bounceMsg).not.toContain("restart");
    // 新消息承载重整：3 条消息（原始 + bounce 新消息…实际上 auto-retry 复用原消息，bounce 新建 1 条）
    expect(msg._startedMessages.length).toBeGreaterThanOrEqual(2);
    // 幽灵 sender 门禁（2026-09-04 修复）：重试新建消息的 speaker 必须是当前獭 otterId，
    // 不是触发者 senderId（曾误传致 49 条「user 海獭」幽灵消息，首例 2026-08-19）
    for (const s of msg._startInputs) {
      expect(s.senderId).toBe("otter-1");
      expect(s.senderId).not.toBe("user-1");
    }
    // 发言石去向保持触发者（重试失败兑底时回传触发者，语义正确）
    expect(msg._startInputs.at(-1)!.talkingStonePassedTo).toContain("user-1");
    // bounce 计数落账：guard_intercept + bounce=true
    const bounceEvent = healing.events.find(e =>
      e.errorType === "guard_intercept" && (e.context as { bounce?: boolean })?.bounce === true);
    expect(bounceEvent).toBeTruthy();
    // 回发后自纠成功：最终 invoke 完成，链正常交棒（事故 C 形态不复现）
    expect(invoke._count()).toBe(3);
    expect(result.aggregatedTargets).toEqual(["user-1"]);
    // bounce 轮的 LLM 输入含回发消息（新消息重整）
    expect(invoke._contexts[2]).toContain("自动回发控制信号");
  });

  it("GB-3：滑窗内已回发 3 次 → 停止回发升级：abort 终态 + 升级系统消息 + healing high", async () => {
    const msg = mockSendMessage();
    // seed 3 条窗口内 bounce 事件 → 本轮是第 4 次，超限
    const healing = mockHealingRepo([
      seedBounceEvent(), seedBounceEvent(), seedBounceEvent(),
    ]);
    const invoke = mockAgentInvoke([{ guard: 2 }]);
    const invoker = new AgentInvoker(
      invoke, msg, mockQueryMessage(), mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // 超限：不再回发，abort 终态
    expect(msg._abortCalls).toHaveLength(1);
    expect(msg._sendSystemBodies).toContainEqual(expect.stringContaining("已连续 3 次被 bash 守卫拦截"));
    // 升级 healing high：abortTerminal 终态分支落账
    const highEvents = healing.events.filter(e => e.severity === "high");
    expect(highEvents.length).toBeGreaterThanOrEqual(1);
    // 无新 bounce 计数落账（超限路径不写）
    const bounceEvents = healing.events.filter(e =>
      e.errorType === "guard_intercept" && (e.context as { bounce?: boolean })?.bounce === true);
    expect(bounceEvents).toHaveLength(3); // 仅 seed 的 3 条
    // 无回发消息（不含回发进度文案）
    expect(msg._sendSystemBodies.find(b => b.includes("第 4/3 次"))).toBeUndefined();
  });

  it("GB-3b：窗口外 bounce 不计数（10 分钟前的教训不堵死现在的自纠）", async () => {
    const msg = mockSendMessage();
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const healing = mockHealingRepo([
      seedBounceEvent({ createdAt: elevenMinutesAgo }),
      seedBounceEvent({ createdAt: elevenMinutesAgo }),
      seedBounceEvent({ createdAt: elevenMinutesAgo }),
    ]);
    const invoke = mockAgentInvoke([{ guard: 2 }, { done: true }]);
    const invoker = new AgentInvoker(
      invoke, msg, mockQueryMessage(), mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // 窗口外不计入：照常回发（第 1/3 次而非升级）
    expect(msg._abortCalls).toHaveLength(0);
    const bounceMsg = msg._sendSystemBodies.find(b => b.includes("自动回发控制信号"));
    expect(bounceMsg).toContain("第 1/3 次");
  });

  it("GB-4：计数查询失败（台账失明）→ fail-closed 升级，不无限回发", async () => {
    const msg = mockSendMessage();
    const healing = mockHealingRepo([], { failQuery: true });
    const invoke = mockAgentInvoke([{ guard: 2 }]);
    const invoker = new AgentInvoker(
      invoke, msg, mockQueryMessage(), mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // 台账失明 → 升级而非回发
    expect(msg._abortCalls).toHaveLength(1);
    expect(msg._sendSystemBodies).toContainEqual(expect.stringContaining("请人工介入"));
    expect(invoke._count()).toBe(2); // 无回发轮
  });

  it("GB-5：bounce 前 failMessage 已 abort SDK session（dead message 不僵尸运行）", async () => {
    const msg = mockSendMessage();
    const healing = mockHealingRepo();
    const invoke = mockAgentInvoke([{ guard: 2 }, { done: true }]);
    const invoker = new AgentInvoker(
      invoke, msg, mockQueryMessage(), mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // auto-retry 轮与 bounce 轮的 failMessage 各触发一次 sdk abort（F20260830fabt 接线）
    expect(invoke._aborts.length).toBeGreaterThanOrEqual(2);
  });
});
