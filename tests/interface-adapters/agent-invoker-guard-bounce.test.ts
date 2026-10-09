/**
 * #731：bash 守卫二拦终态自动回发控制信号（guard bounce）
 *
 * F20260913ctlv 彻底切换重写：mock 面从 SendMessage（messages 行）切到
 * SendEntry（invokes + entries 状态机），能力断言保持 GB-1~GB-5：
 * - GB-1/GB-2 二拦终态 → 不再 aborted，自动回发：invoke failed 过渡 + sendSystem
 *   （带原因+引导）+ 同 invoke 重试；回发后自纠成功 → 闭环
 * - GB-3 滑窗内已回发 2 次 → 停止回发，abort 终态 + 升级系统消息 + healing high
 *   （F20261008hcpa，#1356 层1 打断：GUARD_BOUNCE_MAX 3→2——同规则第 3 次拦截直接升级）
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
/** F20260928slan：sleep 域 guard reason（验证 orchestrator 三门对 bash_sleep: 适配） */
const SLEEP_GUARD_REASON = "bash_sleep:检测到你使用了 sleep 等待（约 30 秒）。裸 sleep 会让搭档看到长时间静默黑盒。请先 speak 说明你要等什么、为什么要等这么久，然后改用 wait 工具。";

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

/** PR #1360 delta 处置：疑似误拦降级通道数据源改为「拦截结构化事件」（pi-session-factory
 * buildGuardInterceptHook 落账形态——context 含 ruleId/ruleLayer/commandHead，每条对应一轮拦截）。
 * seed 形态对齐生产，防「测试 seed 与生产落账形态脱节」的虚绿（本轮实证的 delta 缺陷正是这种脱节）。 */
function seedInterceptEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
  return {
    id: `gi-${Math.random().toString(36).slice(2)}`,
    messageId: "msg-seed",
    conversationId: "conv-1",
    otterId: "otter-1",
    errorType: "guard_intercept",
    severity: "medium",
    description: "bash 守卫拦截（近 6h 第 1 次）：seed（命令前缀：git commit -m x）",
    suggestion: "",
    context: { layer: "framework", ruleId: "main_write", ruleLayer: "r1_gate", commandHead: "git commit -m x", hasWorktreePath: false },
    status: "open",
    resolution: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...overrides,
  };
}

/** 一轮 bounce 拦截在生产落两条事件：framework 结构化（ruleId/ruleLayer/commandHead，
 * 疑似误拦判定数据源）+ orchestrator bounce 计数（bounce:true，上限判定数据源）。
 * GB-6 系列用此配对 fixture——缺一侧都会让「计数达标但判定失明」或反之，与生产脱节。 */
function seedBounceRound(ruleId: string, ruleLayer: string, commandHead: string): HealingEvent[] {
  return [
    seedInterceptEvent({ context: { layer: "framework", ruleId, ruleLayer, commandHead, hasWorktreePath: false } }),
    seedBounceEvent(),
  ];
}

/**
 * SdkInvokePort mock：bash_safety 场景脚本驱动（F20260913ctlv：SDK 会话键 = invokeId）。
 * script 元素：{ guard: n } = 接下来 n 次 invoke 返回 bash_safety 终态（内部 abort reason），
 * 之后 { done: true } 正常完成（含 yield 语义——onYield 置 invoke completed）。
 */
function mockAgentInvoke(script: Array<{ guard: number } | { done: true }>, guardReason: string = GUARD_REASON) {
  let invokeCount = 0;
  const contexts: string[] = [];
  const aborts: string[] = [];
  const steps: Array<string | undefined> = [];
  for (const step of script) {
    if ("guard" in step) for (let i = 0; i < step.guard; i++) steps.push(guardReason);
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

// eslint-disable-next-line max-lines-per-function -- #731 bounce 能力面 10 用例聚合（GB-1~GB-6d + GB-sleep）；mock 基础设施（mockHealingRepo/mockAgentInvoke/yieldRounds 包装）在文件级共享，拆 describe 需重复造共享块，收益不抵成本
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
    expect(bounceMsg).toContain("第 1/2 次");
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

  it("GB-3：滑窗内已回发 2 次 → 停止回发升级：abort 终态 + 升级系统消息 + healing high", async () => {
    const sendEntry = mockSendEntry();
    // seed 2 条窗口内 bounce 事件 → 本轮是第 3 次，超限（F20261008hcpa：上限 2）
    const healing = mockHealingRepo([
      seedBounceEvent(), seedBounceEvent(),
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
    expect(sendEntry.store.systemBodies.some(b => b.includes("已连续 2 次被 bash 守卫拦截"))).toBe(true);
    // 升级 healing high：abortTerminal 终态分支落账
    const highEvents = healing.events.filter(e => e.severity === "high");
    expect(highEvents.length).toBeGreaterThanOrEqual(1);
    // 无新 bounce 计数落账（超限路径不写）
    const bounceEvents = healing.events.filter(e =>
      e.errorType === "guard_intercept" && (e.context as { bounce?: boolean })?.bounce === true);
    expect(bounceEvents).toHaveLength(2); // 仅 seed 的 2 条
    // 无回发消息（不含回发进度文案）
    expect(sendEntry.store.systemBodies.find(b => b.includes("第 3/2 次"))).toBeUndefined();
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

    // 窗口外不计入：照常回发（第 1/2 次而非升级）
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(0);
    const bounceMsg = sendEntry.store.systemBodies.find(b => b.includes("自动回发控制信号"));
    expect(bounceMsg).toContain("第 1/2 次");
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

  /** F20260928slan D5b：sleep 域（bash_sleep:）纳入 #731 bounce——orchestrator 三门适配验证 */
  it("GB-sleep：sleep 域二拦终态 → 自动回发（bounce 门对 bash_sleep: 开启）→ 回发后自纠成功闭环", async () => {
    const sendEntry = mockSendEntry();
    const healing = mockHealingRepo();
    const invoke = mockAgentInvoke([{ guard: 2 }, { done: true }], SLEEP_GUARD_REASON);
    const wrappedEntry = mockSendEntry();
    Object.assign(wrappedEntry.store, sendEntry.store);
    const yieldRounds = new Set<string>();
    wrappedEntry.getInvokeById = async (invokeId: string) => {
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
      userMessageContent: "等 CI 任务", senderId: "user-1",
    });

    // 二拦终态不再 aborted：bounce 门对 bash_sleep: 开启（shouldGuardBounce + isGuardBounceTerminal 适配）
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(0);
    // bounce sendSystem：含「等待守卫拦截」前缀（D5c bounce 文案 sleep 域分流）
    const bounceMsg = sendEntry.store.systemBodies.find(b => b.includes("自动回发控制信号"));
    expect(bounceMsg).toBeTruthy();
    expect(bounceMsg).toContain("等待守卫拦截");
    expect(bounceMsg).toContain("第 1/2 次");
    expect(bounceMsg).toContain("wait 工具");
    // 不含 kill 域措辞
    expect(bounceMsg).not.toContain("主进程");
    // 回发后自纠成功闭环
    expect(invoke._count()).toBe(3);
    const finalInvoke = [...sendEntry.store.invokes.values()].find(inv => inv.talkingStonePassedTo?.includes("user-1"));
    expect(finalInvoke?.status).toBe("completed");
    expect(result.invokeId).toBeTruthy();

  });

  it("GB-6b：3 连 bounce 命中异规则（mixed ruleId）→ 真违规仍走原 abort 终态（不误判误拦）", async () => {
    const sendEntry = mockSendEntry();
    const healing = mockHealingRepo([
      ...seedBounceRound("self_kill_pidfile", "self_kill", "kill $(cat f)"),
      ...seedBounceRound("self_kill_literal", "self_kill", "kill 42877"),
      ...seedBounceRound("self_kill_pidfile", "self_kill", "kill $(cat f)"),
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

    // 异规则反复撞 = 獭在乱试 → 真违规：仍走原 escalateGuardBounce abort 终态
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(1);
    const escalationMsg = sendEntry.store.systemBodies.find(b => b.includes("已停止自动回发并中断其发言"));
    expect(escalationMsg).toBeTruthy();
    // 不误发疑似误拦通知
    expect(sendEntry.store.systemBodies.find(b => b.includes("疑似误拦"))).toBeFalsy();
  });

  it("GB-6c：3 连 bounce 含 unknown ruleId → 无法判同，保守走 abort（fail-closed）", async () => {
    const sendEntry = mockSendEntry();
    const healing = mockHealingRepo([
      ...seedBounceRound("unknown", "self_kill", "cmd x"),
      ...seedBounceRound("unknown", "self_kill", "cmd x"),
      ...seedBounceRound("unknown", "self_kill", "cmd x"),
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

    // unknown 无法归类「同一规则」→ fail-closed 走原 abort
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(1);
    expect(sendEntry.store.systemBodies.find(b => b.includes("疑似误拦"))).toBeFalsy();
  });

  it("GB-6d：bounce 事件查询失败（台账失明）→ fail-closed 走 abort，不误判误拦", async () => {
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

    // 计数查询失败 → fail-closed 升级 abort（GB-4 语义不回退）
    const abortEnds = sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted");
    expect(abortEnds).toHaveLength(1);
  });
  it("GB-6a：3 连 bounce 命中同一低危规则（main_write/r1_gate）→ 疑似误拦降级：含「大概率误拦」判断 + 命令摘要取最新 + suspected_false_positive 落账", async () => {
    const sendEntry = mockSendEntry();
    // 低危层规则：main_write（r1_gate）——文案保留「大概率误拦」预判；
    // guardReason 对齐 main_write 真实拦截文案（分类归一 currentRuleId/ruleLayer）
    const mainWriteReason = "bash_safety:当前 bash 工作目录在主仓（未 cd 到 worktree）。落点为主仓的写命令被拦截。";
    const healing = mockHealingRepo([
      // 拦截结构化事件（旧→新插入；findRecentByOtter mock DESC 序——数组末位 = 最新）；
      // bounce:true 计数事件与结构化事件并存（对齐生产：每轮 bounce 拦截两类都落）
      ...seedBounceRound("main_write", "r1_gate", "git commit -m old"),
      ...seedBounceRound("main_write", "r1_gate", "git commit -m mid"),
      ...seedBounceRound("main_write", "r1_gate", "git commit -m latest"),
    ]);
    const invoke = mockAgentInvoke([{ guard: 2 }], mainWriteReason);
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

    // P0-2：同规则 3 连且非 unknown → 疑似误拦降级通道：sendSystem 是「疑似误拦」文案（非「已停止自动回发并中断其发言」）
    const fpMsg = sendEntry.store.systemBodies.find(b => b.includes("疑似误拦"));
    expect(fpMsg).toBeTruthy();
    expect(fpMsg).toContain("main_write");
    expect(fpMsg).toContain("请人工核实");
    // 低危层（r1_gate）保留「大概率误拦」预判
    expect(fpMsg).toContain("大概率是守卫误拦");
    expect(fpMsg).not.toContain("已停止自动回发并中断其发言");
    // §3.2 处置：命令摘要取最新一次（DESC 序 events[0]，非最旧）——钉住「取最新」防回退
    expect(fpMsg).toContain("git commit -m latest");
    expect(fpMsg).not.toContain("git commit -m old");
    // 降级通道：invoke 终态 failed（非 aborted——保留手动重试空间，与真违规 abort 区分）
    const fpFail = sendEntry.store.invokeEndCalls.filter(e => e.status === "failed");
    expect(fpFail).toHaveLength(1);
    expect(sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted")).toHaveLength(0);
    // 落账 suspected_false_positive high（守卫可信度问题需人工跟进）
    const fpEvent = healing.events.find(e =>
      e.errorType === "guard_intercept" &&
      (e.context as { suspectedFalsePositive?: boolean })?.suspectedFalsePositive === true);
    expect(fpEvent).toBeTruthy();
    expect(fpEvent?.severity).toBe("high");
  });

  it("GB-6e：3 连 bounce 命中同一高危规则（self_kill/self_kill 层）→ 降级但通知中性化：不含「大概率误拦」预判，引导核实正当性", async () => {
    const sendEntry = mockSendEntry();
    const healing = mockHealingRepo([
      ...seedBounceRound("self_kill_literal", "self_kill", "kill 42877"),
      ...seedBounceRound("self_kill_literal", "self_kill", "kill 42877"),
      ...seedBounceRound("self_kill_literal", "self_kill", "kill 42877"),
    ]);
    const invoke = mockAgentInvoke([{ guard: 2 }]); // 默认 GUARD_REASON 即 self_kill_literal 文案
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

    // 高危层仍走降级（同规则 3 连 → 不 abort）
    expect(sendEntry.store.invokeEndCalls.filter(e => e.status === "aborted")).toHaveLength(0);
    expect(sendEntry.store.invokeEndCalls.filter(e => e.status === "failed")).toHaveLength(1);
    // §3.5 处置：但通知文案中性化——不预判「大概率误拦」，改请核实正当性 + 明示不要放行
    const fpMsg = sendEntry.store.systemBodies.find(b => b.includes("疑似误拦"));
    expect(fpMsg).toBeTruthy();
    expect(fpMsg).toContain("self_kill_literal");
    expect(fpMsg).not.toContain("大概率是守卫误拦");
    expect(fpMsg).toContain("核实此命令是否正当");
    expect(fpMsg).toContain("不要放行");
    // 给獭的降级提示同口径中性化——落 invoke_end entry body（finalizeInvokeFailed 的 failBody）
    const failBody = sendEntry.store.invokeEndCalls.find(e => e.status === "failed")?.body ?? "";
    expect(failBody).not.toContain("大概率是守卫误拦");
    expect(failBody).toContain("请求人工核实");
  });

});
