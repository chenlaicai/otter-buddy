/**
 * F20260910ctlv 彻底切换：熔断与重试路径测试（invoke 状态机语义）。
 *
 * 覆盖（原 circuit-break/rate-limit/guard-bounce 测试族的存活语义）：
 * - 首次退化（无 healingRepo）：降级 abort 终态
 * - 熔断启用（healingRepo + sendSystem）：首次退化 → 熔断重启 + 全新 invoke
 * - 熔断上限：session 由熔断创建（2h 内）再退化 → abort 终态 + 系统通知
 * - rate_limit：api_error 识别为配额耗尽 → healing 落账 + 系统告警 + invoke failed
 * - guard bounce（bash_safety 二拦）：回发重试（计数上限由 healing_events 记录）
 */

import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingEvent } from "@entities/healing/healing-event";
import { createTestLogger } from "../helpers/logger";
import { mockSendEntry } from "../helpers/mock-send-entry";

function mockSendMessage(): SendMessage {
  return {} as unknown as SendMessage;
}
function mockQueryMessage(): QueryMessage {
  return { getMessageById: async () => null, getMessages: async () => [], getLastMessageBySenderType: async () => null } as unknown as QueryMessage;
}
function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1", otterId: "otter-1", status: "active",
    previousSessionId: null, startedAt: "2026-08-05T00:00:00Z",
    archivedAt: null, archiveReason: null, isNegativeCase: false,
    summary: null, modelAlias: null,
    ...overrides,
  };
}
function mockManageSession(overrides?: Partial<ManageSession>): ManageSession {
  return {
    getActiveSession: overrides?.getActiveSession ?? (async () => null),
    createSession: async (otterId: string) => makeSession({ id: "sess-backfill", otterId }),
    restartSession: overrides?.restartSession ?? (async (otterId: string) => makeSession({ id: "sess-new", otterId })),
  } as unknown as ManageSession;
}
function mockQueryOtter(): QueryOtter {
  return {
    getById: async (id: string) => ({ id, name: "Test Otter", type: "small", status: "active", role: null, parentOtterId: null, createdAt: "2026-07-16T00:00:00Z", dissolvedAt: null }),
  } as unknown as QueryOtter;
}
function mockHealingRepo(seed: HealingEvent[] = []) {
  const events = [...seed];
  return {
    events,
    repo: {
      create: async (event: HealingEvent) => { events.push(event); },
      findRecentByOtter: async (otterId: string, errorType: string, limit = 10) =>
        events.filter(e => e.otterId === otterId && e.errorType === errorType).slice(-limit).reverse(),
      findOpen: async () => [],
      findAll: async () => [],
    } as unknown as HealingEventRepository,
  };
}

function makeInvoker(
  sdk: SdkInvokePort,
  sendEntry: ReturnType<typeof mockSendEntry>,
  opts?: { manageSession?: ManageSession; healingRepo?: HealingEventRepository },
): AgentInvoker {
  return new AgentInvoker(
    sdk, mockSendMessage(), mockQueryMessage(), opts?.manageSession ?? mockManageSession(), mockQueryOtter(), createTestLogger(),
    undefined, undefined, undefined, undefined,
    opts?.healingRepo,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    sendEntry,
    { getInvokeEvents: async () => [] } as never,
  );
}

describe("AgentInvoker 熔断与重试（F20260910ctlv：invoke 状态机）", () => {
  it("首次退化（无 healingRepo）：降级 abort 终态，不熔断", async () => {
    const sendEntry = mockSendEntry();
    const sdk = {
      invoke: async () => Object.assign({ text: "" }, { _guardAbortReason: "degenerate_output" }),
      abort: () => {}, getToolCallCount: () => 0, getInternalAbortReason: () => undefined,
    } as unknown as SdkInvokePort;
    const invoker = makeInvoker(sdk, sendEntry);

    const events: { event: string; data: Record<string, unknown> }[] = [];
    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status).toBe("aborted");
    // 无熔断重启（invoke 只有一个）
    expect(sendEntry.store.invokes.size).toBe(1);
  });

  it("首次退化（healingRepo 注入）：熔断 → restart + 全新 invoke（二段 invoke）", async () => {
    const sendEntry = mockSendEntry();
    let restarts = 0;
    const manageSession = mockManageSession({
      restartSession: async (otterId: string) => { restarts++; return makeSession({ id: `sess-rb-${restarts}`, otterId }); },
    });
    const healing = mockHealingRepo();
    let calls = 0;
    const sdk = {
      invoke: async () => {
        calls++;
        // 第二段（熔断重启后全新 invoke）正常 yield
        if (calls >= 2) return { text: "" };
        return Object.assign({ text: "" }, { _guardAbortReason: "degenerate_output" });
      },
      abort: () => {}, getToolCallCount: () => 0, getInternalAbortReason: () => undefined,
    } as unknown as SdkInvokePort;
    // 全新 invoke 的 yield 模拟：第二段 invoke 查询时置 completed
    const wrappedEntry = mockSendEntry();
    Object.assign(wrappedEntry.store, sendEntry.store);
    wrappedEntry.getInvokeById = async (id: string) => {
      const invoke = sendEntry.store.invokes.get(id) ?? null;
      if (invoke && calls >= 2) {
        invoke.status = "completed";
        invoke.talkingStonePassedTo = ["user-1"];
      }
      return invoke;
    };
    const invoker = makeInvoker(sdk, wrappedEntry as never, { manageSession, healingRepo: healing.repo });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    expect(restarts).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    // circuit_break healing 事件已落账
    expect(healing.events.some(e => e.errorType === "circuit_break")).toBe(true);
    // degenerate 事件已落账
    expect(healing.events.some(e => e.errorType === "degenerate")).toBe(true);
  });

  it("熔断上限：session 由熔断创建（2h 内）再退化 → abort 终态 + 系统通知", async () => {
    const sendEntry = mockSendEntry();
    const cbSession = makeSession({ id: "sess-cb", startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    const manageSession = mockManageSession({ getActiveSession: async () => cbSession });
    const healing = mockHealingRepo([{
      id: "he-cb", messageId: "", conversationId: "conv-1", otterId: "otter-1",
      errorType: "circuit_break", severity: "medium", description: "",
      suggestion: "", context: { newSessionId: "sess-cb" }, status: "open",
      resolution: null, createdAt: new Date().toISOString(), resolvedAt: null,
    }]);
    const sdk = {
      invoke: async () => Object.assign({ text: "" }, { _guardAbortReason: "degenerate_output" }),
      abort: () => {}, getToolCallCount: () => 0, getInternalAbortReason: () => undefined,
    } as unknown as SdkInvokePort;
    const invoker = makeInvoker(sdk, sendEntry, { manageSession, healingRepo: healing.repo });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status).toBe("aborted");
    // 上限系统通知已发
    expect(sendEntry.store.systemBodies.some(b => b.includes("熔断上限"))).toBe(true);
  });

  it("rate_limit（配额耗尽）：healing 落账 + 系统告警 + invoke failed", async () => {
    const sendEntry = mockSendEntry();
    const healing = mockHealingRepo();
    const sdk = {
      invoke: async () => { throw Object.assign(new Error("429 Too Many Requests. quota exhausted, resets at 2026-09-11T00:00:00Z"), {}); },
      abort: () => {}, getToolCallCount: () => 0, getInternalAbortReason: () => undefined,
    } as unknown as SdkInvokePort;
    const invoker = makeInvoker(sdk, sendEntry, { healingRepo: healing.repo });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status).toBe("failed");
    expect(healing.events.some(e => e.errorType === "rate_limit")).toBe(true);
    expect(sendEntry.store.systemBodies.some(b => b.includes("限流") || b.includes("配额"))).toBe(true);
  });

  it("bash_safety 二拦（retry 后再犯）：guard bounce 回发或升级，invoke 进入终态", async () => {
    const sendEntry = mockSendEntry();
    const healing = mockHealingRepo();
    const sdk = {
      invoke: async () => {
        return Object.assign({ text: "" }, { _guardAbortReason: "bash_safety:danger_command" });
      },
      abort: () => {}, getToolCallCount: () => 0, getInternalAbortReason: () => undefined,
    } as unknown as SdkInvokePort;
    const invoker = makeInvoker(sdk, sendEntry, { healingRepo: healing.repo });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
    });

    // 二拦终态：invoke aborted（bounce 耗尽升级）
    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(["aborted", "failed"]).toContain(invoke.status);
    // guard_intercept healing 留痕
    expect(healing.events.some(e => e.errorType === "guard_intercept")).toBe(true);
  });
});
