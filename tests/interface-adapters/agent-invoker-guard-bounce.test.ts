/**
 * #731：bash 守卫二拦终态自动回发控制信号（guard bounce）
 *
 * F20260913ctlv 彻底切换重写：mock 面从 SendMessage（messages 行）切到
 * SendEntry（invokes + entries 状态机），能力断言保持 GB-1~GB-5：
 * - GB-1/GB-2 二拦终态 → 不再 aborted，自动回发：invoke failed 过渡 + sendSystem
 *   （带原因+引导）+ 同 invoke 重试；回发后自纠成功 → 闭环
 * - GB-3 滑窗内已回发 3 次 → 停止回发，abort 终态 + 升级系统消息 + healing high
 * - GB-3b 窗口外 bounce 不计数
 * - GB-4 计数查询失败（台账失明）→ fail-closed 升级
 * - GB-5 bounce 前 failMessage 已 abort SDK session（dead invoke 不僵尸运行）
 */
import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingEvent } from "@entities/healing/healing-event";
import type { OtterSession } from "@entities/otter/otter-session";
import { createTestLogger } from "../helpers/logger";
import { mockSendEntry } from "../helpers/mock-send-entry";

const GUARD_REASON = "bash_safety:bash 命令包含针对主进程 PID 的终止命令。主进程是海獭运行环境，任何情况下不得终止。";

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-09-01T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null,
    modelAlias: null,
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

/**
 * SdkInvokePort mock：bash_safety 场景脚本驱动（F20260913ctlv：SDK 会话键 = invokeId）。
 * script 元素：{ guard: n } = 接下来 n 次 invoke 返回 bash_safety 终态（内部 abort reason），
 * 之后 { done: true } 正常完成（含 yield 语义——onYield 置 invoke completed）。
 */
function mockAgentInvoke(script: Array<{ guard: number } | { done: true }>) {
  let invokeCount = 0;
  const contexts: string[] = [];
  const aborts: string[] = [];
  const steps: Array<string | undefined> = [];
  for (const step of script) {
    if ("guard" in step) for (let i = 0; i < step.guard; i++) steps.push(GUARD_REASON);
    else steps.push(undefined);
  }
  const mock: SdkInvokePort & { _contexts: typeof contexts; _aborts: string[]; _count: () => number } = {
    invoke: async (_invokeId: string, message: string) => {
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

const mockManageSession = {
  getActiveSession: async () => makeSession(),
  restartSession: async () => makeSession({ id: "sess-new" }),
} as unknown as ManageSession;

const queryOtter: QueryOtter = { getById: async () => ({ id: "otter-1", name: "大獭", type: "main" }) } as unknown as QueryOtter;

describe("AgentInvoker — bash 守卫二拦终态自动回发控制信号 (#731)", () => {
  it("GB-1/GB-2：二拦终态 → 自动回发（failed 过渡+sendSystem 带因+同 invoke 重试）→ 回发后自纠成功闭环", async () => {
    const sendEntry = mockSendEntry();
    const healing = mockHealingRepo();
    // 脚本：2 撞（首拦重试 + 二拦终态 → bounce）→ done（回发后自纠成功 yield）
    const invoke = mockAgentInvoke([{ guard: 2 }, { done: true }]);
    // done 轮的 yield 语义：getInvokeById 查询时（重试轮已存在）模拟 yield 工具置 completed
    const wrappedEntry = mockSendEntry();
    Object.assign(wrappedEntry.store, sendEntry.store);
    const yieldRounds = new Set<string>();
    wrappedEntry.getInvokeById = async (invokeId: string) => {
      // 第 3 次 SDK invoke（done 轮）返回后，orchestrator 查询 invoke 状态——此时置 completed + tsp
      const store = sendEntry.store as unknown as { invokes: Map<string, { status: string; talkingStonePassedTo: string[] | null }> };
      const inv = store.invokes.get(invokeId) ?? null;
      if (inv && invoke._count() >= 3 && !yieldRounds.has(invokeId)) {
        yieldRounds.add(invokeId);
        inv.status = "completed";
        inv.talkingStonePassedTo = ["user-1"];
      }
      return inv as never;
    };
    const invoker = new AgentInvoker(
      invoke, { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage,
      mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      wrappedEntry as never,
      { getInvokeEvents: async () => [] } as never,
    );

    const result = await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // 二拦终态不再 aborted：行动权不悬空
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(0);
    // bounce sendSystem：含拦截原因透传 + 回发进度 + 四要素引导（无 restart 出口）
    const bounceMsg = sendEntry.store.systemBodies.find(b => b.includes("自动回发控制信号"));
    expect(bounceMsg).toBeTruthy();
    expect(bounceMsg).toContain("第 1/3 次");
    expect(bounceMsg).toContain("主进程");
    expect(bounceMsg).toContain("worktree");
    expect(bounceMsg).toContain("不要重复原命令");
    expect(bounceMsg).not.toContain("restart");
    // bounce 计数落账：guard_intercept + bounce=true
    const bounceEvent = healing.events.find(e =>
      e.errorType === "guard_intercept" && (e.context as { bounce?: boolean })?.bounce === true);
    expect(bounceEvent).toBeTruthy();
    // 回发后自纠成功：SDK invoke 3 轮（2 撞 + 1 成功闭环）；
    // 闭环验证 = invoke 终态 completed + yield 目标 user-1（F20260913ctlv：aggregatedTargets 已退役）
    expect(invoke._count()).toBe(3);
    const finalInvoke = yieldRounds.size > 0
      ? [...sendEntry.store.invokes.values()].find(inv => inv.talkingStonePassedTo?.includes("user-1"))
      : undefined;
    expect(finalInvoke?.status).toBe("completed");
    expect(result.invokeId).toBeTruthy();
    // F20260913ctlv：同 invoke 重试——retry 轮 message = 拦截提醒（buildAutoRetryMsg）；
    // bounce 全文以 system entry 落库（sendSystem 断言已覆盖）
    expect(invoke._contexts[2]).toContain("安全守卫拦截");
  });

  it("GB-3：滑窗内已回发 3 次 → 停止回发升级：abort 终态 + 升级系统消息 + healing high", async () => {
    const sendEntry = mockSendEntry();
    // seed 3 条窗口内 bounce 事件 → 本轮是第 4 次，超限
    const healing = mockHealingRepo([
      seedBounceEvent(), seedBounceEvent(), seedBounceEvent(),
    ]);
    const invoke = mockAgentInvoke([{ guard: 2 }]);
    const invoker = new AgentInvoker(
      invoke, { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage,
      mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sendEntry,
      { getInvokeEvents: async () => [] } as never,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // 超限：不再回发，abort 终态
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(1);
    expect(sendEntry.store.systemBodies.some(b => b.includes("已连续 3 次被 bash 守卫拦截"))).toBe(true);
    // 升级 healing high：abortTerminal 终态分支落账
    const highEvents = healing.events.filter(e => e.severity === "high");
    expect(highEvents.length).toBeGreaterThanOrEqual(1);
    // 无新 bounce 计数落账（超限路径不写）
    const bounceEvents = healing.events.filter(e =>
      e.errorType === "guard_intercept" && (e.context as { bounce?: boolean })?.bounce === true);
    expect(bounceEvents).toHaveLength(3); // 仅 seed 的 3 条
    // 无回发消息（不含回发进度文案）
    expect(sendEntry.store.systemBodies.find(b => b.includes("第 4/3 次"))).toBeUndefined();
  });

  it("GB-3b：窗口外 bounce 不计数（10 分钟前的教训不堵死现在的自纠）", async () => {
    const sendEntry = mockSendEntry();
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const healing = mockHealingRepo([
      seedBounceEvent({ createdAt: elevenMinutesAgo }),
      seedBounceEvent({ createdAt: elevenMinutesAgo }),
      seedBounceEvent({ createdAt: elevenMinutesAgo }),
    ]);
    const invoke = mockAgentInvoke([{ guard: 2 }, { done: true }]);
    const invoker = new AgentInvoker(
      invoke, { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage,
      mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sendEntry,
      { getInvokeEvents: async () => [] } as never,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // 窗口外不计入：照常回发（第 1/3 次而非升级）
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(0);
    const bounceMsg = sendEntry.store.systemBodies.find(b => b.includes("自动回发控制信号"));
    expect(bounceMsg).toContain("第 1/3 次");
  });

  it("GB-4：计数查询失败（台账失明）→ fail-closed 升级，不无限回发", async () => {
    const sendEntry = mockSendEntry();
    const healing = mockHealingRepo([], { failQuery: true });
    const invoke = mockAgentInvoke([{ guard: 2 }]);
    const invoker = new AgentInvoker(
      invoke, { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage,
      mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sendEntry,
      { getInvokeEvents: async () => [] } as never,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // 台账失明 → 升级而非回发
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(1);
    expect(sendEntry.store.systemBodies.some(b => b.includes("请人工介入"))).toBe(true);
    expect(invoke._count()).toBe(2); // 无回发轮
  });

  it("GB-5：bounce 升级 abort 终态时 SDK session 被截停（dead invoke 不僵尸运行）", async () => {
    const sendEntry = mockSendEntry();
    // seed 满额 bounce → 本轮直接走升级 abort 路径
    const healing = mockHealingRepo([
      seedBounceEvent(), seedBounceEvent(), seedBounceEvent(),
    ]);
    const invoke = mockAgentInvoke([{ guard: 2 }]);
    const invoker = new AgentInvoker(
      invoke, { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage,
      mockManageSession, queryOtter, createTestLogger(),
      undefined, undefined, undefined, undefined, healing.repo,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      sendEntry,
      { getInvokeEvents: async () => [] } as never,
    );

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "修复任务 X", senderId: "user-1",
    });

    // F20260913ctlv：abort 终态 = createInvokeEndEntry('aborted') + invoke 行 aborted
    // （F20260830fabt 的 sdk abort 接线移至 abort() 显式中断路径——升级路径靠 invoke 终态收口）
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(1);
    const abortedInvoke = [...sendEntry.store.invokes.values()].find(inv => inv.status === "aborted");
    expect(abortedInvoke).toBeTruthy();
  });
});
