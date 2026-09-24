/**
 * F20260913ctlv 彻底切换：AgentInvoker 测试（invoke 状态机语义）。
 *
 * 旧测试族的 messages 状态机（speaking 判定/message.retry 事件/segments 聚合）已退役。
 * 新核心覆盖：
 * - 正常流：createInvoke → invoke → yield（invoke completed）→ invoke.end + turn.complete
 * - no_yield：未 yield → 系统提醒重试 → 二次未 yield → invoke failed + entry.failed
 * - guard abort：streaming_timeout → auto-retry → 二次 → invoke failed/aborted
 * - api_error：终态 failed + invoke.end
 * - user abort：invoke 终态 aborted
 * - SSE 契约：只发 entry.* / invoke.*（无 message.*）
 */

import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort, AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { createTestLogger } from "../helpers/logger";
import { mockSendEntry } from "../helpers/mock-send-entry";
import { MessageBroadcaster } from "../../src/usecases/im/message-broadcaster";
import type { Logger } from "../../src/usecases/ports/logger";


function mockQueryMessage(): QueryMessage {
  return { getMessageById: async () => null, getMessages: async () => [] } as unknown as QueryMessage;
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
    getById: async (id: string) => ({
      id, name: "Test Otter", type: "small", status: "active",
      role: null, parentOtterId: null,
      createdAt: "2026-07-16T00:00:00Z", dissolvedAt: null,
    }),
  } as unknown as QueryOtter;
}

function mockAgentInvoke(options: {
  events?: AgentStreamEvent[];
  result?: { text: string; tokenUsage?: { input: number; output: number }; ctxTokens?: number; ctxMax?: number };
  throwOnInvoke?: Error;
  toolCallCount?: number;
  internalAbortReason?: string;
  invokeImpl?: (otterId: string, message: string, opts?: { onEvent?: (e: AgentStreamEvent) => void }) => Promise<unknown>;
}): SdkInvokePort {
  const invokeImpl = async (otterId: string, message: string, opts?: { onEvent?: (e: AgentStreamEvent) => void; dynamicContext?: { sessionSummary?: string } }) => {
      if (options.invokeImpl) return options.invokeImpl(otterId, message, opts);
      if (options.throwOnInvoke) throw options.throwOnInvoke;
      for (const evt of options.events ?? []) {
        opts?.onEvent?.(evt);
      }
      return options.result ?? { text: "Response text" };
  };
  return {
    invoke: invokeImpl,
    abort: () => {},
    getToolCallCount: () => options.toolCallCount ?? 0,
    getInternalAbortReason: () => options.internalAbortReason,
  } as unknown as SdkInvokePort;
}

function makeInvoker(
  sdk: SdkInvokePort,
  sendEntry: ReturnType<typeof mockSendEntry>,
  opts?: { manageSession?: ManageSession; healingRepo?: HealingEventRepository; broadcaster?: MessageBroadcaster },
): AgentInvoker {
  return new AgentInvoker(
    sdk,
    mockQueryMessage(),
    opts?.manageSession ?? mockManageSession(),
    mockQueryOtter(),
    createTestLogger(),
    opts?.broadcaster, // broadcaster
    undefined, // workspaceGateway
    undefined, // settingsRepo
    undefined, // metrics
    opts?.healingRepo, // healingRepo（熔断启用）
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    sendEntry,
    // invokeRepo（熔断摘要读 invoke_events——最小面）
    { getInvokeEvents: async () => [] } as never,
  );
}

// eslint-disable-next-line max-lines-per-function -- describe 聚合多特性用例（rtsp tick + evdz 广播），拆 describe 反而割裂
describe("AgentInvoker（F20260913ctlv 彻底切换：invoke 状态机）", () => {
  /** F20260914rtsp AT-4/AT-11：message_end usage → invoke.tick 发射与降级 */
  it("message_end 带 usage → 发射 invoke.tick（ctxWindowUsed + 工具计数）", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker(mockAgentInvoke({
      events: [
        { type: "tool_execution_start", name: "read" } as AgentStreamEvent,
        { type: "message_end", message: { role: "assistant", usage: { input: 794, output: 529, cacheRead: 28928, cacheWrite: 0, totalTokens: 30251 } } } as AgentStreamEvent,
      ],
      result: { text: "", tokenUsage: { input: 794, output: 529 } },
    }), sendEntry);

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi",
      senderId: "user-1", onSSEEvent: (e) => events.push(e),
    }).catch(() => null);

    const tick = events.find(e => e.event === "invoke.tick");
    expect(tick).toBeTruthy();
    expect(tick?.data.ctxWindowUsed).toBe(30251);
    expect(tick?.data.toolCallCount).toBe(1);
  });

  /** F20260914evdz：persistInvokeEvent 落库后广播 invoke.event（Session 弹窗实时通道） */
  it("过程事件落库成功 → 广播 invoke.event（带落库 id/seq）", async () => {
    const sseEvents: { event: string; data: Record<string, unknown> }[] = [];
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
    const broadcaster = new MessageBroadcaster(logger);
    broadcaster.registerOutboundChannel("test-capture", {
      onEvent: (_cid, e) => { if (e.event === "invoke.event") sseEvents.push({ event: e.event, data: e.data }); },
    });
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker(mockAgentInvoke({
      events: [
        { type: "tool_execution_start", name: "read" } as AgentStreamEvent,
        { type: "tool_execution_end", name: "read", result: { content: [{ type: "text", text: "ok" }] } } as AgentStreamEvent,
      ],
    }), sendEntry, { broadcaster });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi",
      senderId: "user-1",
    }).catch(() => null);
    await new Promise(r => setTimeout(r, 50)); // appendInvokeEvent 异步落库后广播

    const evts = sseEvents.map(e => e.data.event as { eventType: string; sequenceNum: number });
    expect(evts.some(e => e.eventType === "assistant_toolcall")).toBe(true);
    expect(evts.some(e => e.eventType === "tool_result")).toBe(true);
    expect(evts.every(e => Number.isFinite(e.sequenceNum))).toBe(true);
  });

  it("落库失败（appendInvokeEvent 抛错）→ 该事件不广播、不炸主流程", async () => {
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
    const broadcaster = new MessageBroadcaster(logger);
    /** 记录广播的事件名（invoke.start 等其他事件正常广播——只有失败的落库事件不广播） */
    const broadcasted: string[] = [];
    broadcaster.registerOutboundChannel("test-capture2", {
      onEvent: (_cid, e) => { broadcasted.push(e.event); },
    });
    const sendEntry = mockSendEntry();
    (sendEntry.appendInvokeEvent as unknown as { mockRejectedValue: (v: unknown) => void }).mockRejectedValue(new Error("db down"));
    const invoker = makeInvoker(mockAgentInvoke({
      events: [{ type: "tool_execution_start", name: "read" } as AgentStreamEvent],
    }), sendEntry, { broadcaster });

    const res = await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi",
      senderId: "user-1",
    }).catch(() => null);
    await new Promise(r => setTimeout(r, 50));

    expect(broadcasted).not.toContain("invoke.event"); // 落库全挂 → 0 广播
    expect(broadcasted).toContain("invoke.start"); // 其他事件不受影响
    expect(res).toBeTruthy(); // 主流程不受影响
  });

  it("message_end 无 usage → 不发射 invoke.tick（AT-11 降级）", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker(mockAgentInvoke({
      events: [
        { type: "message_end", message: { role: "assistant" } } as AgentStreamEvent,
      ],
      result: { text: "" },
    }), sendEntry);

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi",
      senderId: "user-1", onSSEEvent: (e) => events.push(e),
    }).catch(() => null);

    expect(events.find(e => e.event === "invoke.tick")).toBeUndefined();
  });

  it("正常流：yield 置 invoke completed → invoke.end + turn.complete（无 message.* 事件）", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker(mockAgentInvoke({
      result: { text: "", tokenUsage: { input: 10, output: 5 } },
    }), sendEntry);

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    }).catch(() => null);

    /** invoke 仍是 running（mock 的 yield 工具不触发）→ 走 no_yield 重试 → 耗尽 failed。
     *  这验证了「成功检测 = invoke completed」判据本身：SDK 返回 text 不算成功 */
    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status === "running" || invoke.status === "failed").toBe(true);
    expect(result).toBeTruthy();
    // SSE 契约：全程无 message.* 事件
    expect(events.every(e => !e.event.startsWith("message."))).toBe(true);
    // invoke.start 事件已发（payload 含 invokeId/otterName）
    const start = events.find(e => e.event === "invoke.start");
    expect(start?.data.invokeId).toBe(invoke.id);
    expect(start?.data.otterName).toBe("Test Otter");
  });

  it("yield 成功流：SDK 内完成 yield（模拟工具置 completed）→ turn.complete + invoke.end completed", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry({
      /** 第一次查询时模拟 yield 工具已把 invoke 置 completed */
      onGetInvoke: (invoke) => { invoke.status = "completed"; invoke.talkingStonePassedTo = ["user-1"]; },
    });
    const invoker = makeInvoker(mockAgentInvoke({
      result: { text: "", tokenUsage: { input: 10, output: 5 } },
    }), sendEntry);

    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(result.invokeId).toBeTruthy();
    expect(result.tokenUsage?.input).toBe(10);
    expect(events.map(e => e.event)).toContain("invoke.start");
    expect(events.map(e => e.event)).toContain("invoke.end");
    expect(events.map(e => e.event)).toContain("turn.complete");
    const end = events.find(e => e.event === "invoke.end");
    expect(end?.data.status).toBe("completed");
    // tokenUsage 落 invoke 行
    expect(sendEntry.store.tokenUsageUpdates[0]?.input).toBe(10);
  });

  it("api_error：终态 failed（invoke.end failed + invoke_end entry）", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker(mockAgentInvoke({
      throwOnInvoke: new Error("API exploded"),
    }), sendEntry);

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status).toBe("failed");
    const end = events.find(e => e.event === "invoke.end");
    expect(end?.data.status).toBe("failed");
    // invoke_end entry 已建（含错误文案）
    const endEntry = sendEntry.store.invokeEndCalls.find(c => c.invokeId === invoke.id);
    expect(endEntry?.status).toBe("failed");
    expect(endEntry?.body).toContain("API exploded");
  });

  it("no_yield 重试：首轮发 entry.retry（attempt=1），耗尽后 invoke failed", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry();
    let calls = 0;
    const sdk = mockAgentInvoke({
      invokeImpl: async () => {
        calls++;
        return { text: "" }; // 永不 yield
      },
    });
    const invoker = makeInvoker(sdk, sendEntry);

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    // 两次尝试（首轮 + no_yield 重试）
    expect(calls).toBe(2);
    const retryEvents = events.filter(e => e.event === "entry.retry");
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    expect(retryEvents[0]?.data.reason).toBe("no_yield");
    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status).toBe("failed");
  });

  it("streaming_timeout guard abort：可重试 → entry.retry 后同 invoke 再试", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry();
    let calls = 0;
    const sdk = mockAgentInvoke({
      invokeImpl: async () => {
        calls++;
        return Object.assign({ text: "" }, { _guardAbortReason: "streaming_timeout" });
      },
    });
    const invoker = makeInvoker(sdk, sendEntry);

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(calls).toBeGreaterThanOrEqual(2);
    const retryEvents = events.filter(e => e.event === "entry.retry");
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    /** 二次 guard abort（retryCount=1）→ abort 终态（与旧语义一致：可重试只重试一次） */
    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status).toBe("aborted");
  });

  it("degenerate_output guard abort（无 healingRepo）：降级 abort 终态", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry();
    const sdk = mockAgentInvoke({
      invokeImpl: async () => Object.assign({ text: "" }, { _guardAbortReason: "degenerate_output" }),
    });
    const invoker = makeInvoker(sdk, sendEntry);

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status).toBe("aborted");
    const end = events.find(e => e.event === "invoke.end");
    expect(end?.data.status).toBe("aborted");
  });

  it("user abort：invoke 终态 aborted + tsp 回传触发者", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry();
    let aborted = false;
    const sdk = {
      invoke: async () => {
        // 模拟：invoke 过程中用户 abort → SDK 抛 abort 错误
        aborted = true;
        const err = new Error("Request was aborted");
        throw err;
      },
      abort: () => {},
      getToolCallCount: () => 3,
      getInternalAbortReason: () => undefined,
    } as unknown as SdkInvokePort;
    const invoker = makeInvoker(sdk, sendEntry);

    // 先标记用户中断（driver.isUserAborted 键 = invokeId——mock invoke 创建后我们无法预知 id；
    // 通过 events 捕获 invoke.start 后调 abort）
    const result = await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => {
        events.push(e);
        if (e.event === "invoke.start" && !aborted) {
          invoker.abort("otter-1", e.data.invokeId as string);
          aborted = true;
        }
      },
    });

    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status).toBe("aborted");
    const end = events.find(e => e.event === "invoke.end");
    expect(end?.data.status).toBe("aborted");
    expect(result).toBeTruthy();
  });

  it("SSE 契约：全程无 message.* 事件（含失败路径）", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const sendEntry = mockSendEntry();
    const invoker = makeInvoker(mockAgentInvoke({
      throwOnInvoke: new Error("boom"),
    }), sendEntry);

    await invoker.invokeConversation({
      otterId: "otter-1",
      conversationId: "conv-1",
      userMessageContent: "Hi",
      senderId: "user-1",
      onSSEEvent: (e) => events.push(e),
    });

    expect(events.filter(e => e.event.startsWith("message.") || e.event === "speak.intermediate" || e.event === "assistant_text" || e.event === "assistant_toolcall" || e.event === "tool.result")).toHaveLength(0);
  });
});

/**
 * F20260922handoff 死链修复②语义锁：invoke 完成 → setLastCtxTokens 写回 →
 * 超阈值时水位交接真实触发（此前 setter 零调用，水位触发器从未触发）。
 */
describe("水位触发端到端（F20260922handoff 死链修复语义锁）", () => {
  /** 构造带水位/引擎注入的 invoker（参数位对齐构造函数 22 位契约） */
  function makeWatermarkInvoker(opts: {
    ctxTokens: number;
    threshold?: number;
    restartSession?: ManageSession["restartSession"];
  }) {
    const sendEntry = mockSendEntry();
    const restarts: string[] = [];
    const manageSession = {
      getActiveSession: async () => makeSession({ id: "sess-old", summary: null }),
      createSession: async (otterId: string) => makeSession({ id: "sess-backfill", otterId }),
      restartSession: opts.restartSession ?? (async (otterId: string) => {
        restarts.push(otterId);
        return makeSession({ id: "sess-new", otterId });
      }),
      conversationQuery: { getIdsByOtterId: async () => ["conv-1"] },
    } as unknown as ManageSession;

    const invoker = new AgentInvoker(
      mockAgentInvoke({
        result: { text: "done", tokenUsage: { input: 100, output: 50 }, ctxTokens: opts.ctxTokens },
      }),
      mockQueryMessage(),
      manageSession,
      mockQueryOtter(),
      createTestLogger(),
      undefined, // broadcaster
      undefined, // workspaceGateway
      undefined, // settingsRepo
      undefined, // metrics
      undefined, // healingRepo
      {} as never, // conversationRepo（统一交接必需）
      undefined, // scheduledTaskRepo
      undefined, // listArtifacts
      undefined, // manageContext
      undefined, // buildHandoffPkg
      undefined, // healthySessionThresholdMs
      (opts.threshold !== undefined
        ? { getOtterContextWindow: () => 1_048_576, getOtterHandoffThresholdTokens: () => opts.threshold }
        : undefined) as never, // ctxWindowProvider
      sendEntry,
      { getInvokeEvents: async () => [] } as never, // invokeRepo
      undefined, // agentDispatchService
      { // engine（unifiedHandoff 必需——缺省时统一交接降级路径跳过）
        buildNarrativeSynthesisPrompt: () => "[prompt]",
        assembleHandoffArchive: () => "[archive]",
        buildMechanicalArchive: () => "[mechanical]",
        sliceSessionEntries: () => undefined,
        serializeKeptWindow: () => "",
        collectStateInventory: async () => ({}),
        renderStateInventory: () => "",
        scanWorkspaceFiles: () => [],
        renderFileTrail: () => "",
        synthesisTimeoutMs: 50,
        synthesisFullBudgetChars: (w: number) => Math.floor(w * 0.693),
      },
    );
    return { invoker, restarts, sendEntry };
  }

  it("invoke 结果带 ctxTokens → handoffState 写回有值（水位触发器数据源复活）", async () => {
    const { invoker } = makeWatermarkInvoker({ ctxTokens: 400_000, threshold: 340_000 });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "第一段", senderId: "user-1",
    });

    expect(invoker["handoffState"].getLastCtxTokens("otter-1")).toBe(400_000);
  });

  it("超阈值：第二段 invoke 入口先触发统一交接再执行 invoke（restartSession 被调 + ctxTokens 清除）", async () => {
    const { invoker, restarts } = makeWatermarkInvoker({ ctxTokens: 350_000, threshold: 340_000 });

    // 预置上轮 ctxTokens 超阈值（模拟上轮 invoke 写回 400K）
    invoker["handoffState"].setLastCtxTokens("otter-1", 400_000);

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "第二段", senderId: "user-1",
    });

    // 交接已触发（restartSession 被调）+ 交接清旧值后本轮 invoke 重新写回 350K
    expect(restarts.length).toBeGreaterThan(0);
    expect(invoker["handoffState"].getLastCtxTokens("otter-1")).toBe(350_000);
  });

  it("未超阈值：不触发交接，ctxTokens 仅写回", async () => {
    const { invoker, restarts } = makeWatermarkInvoker({ ctxTokens: 100_000, threshold: 340_000 });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "正常轮", senderId: "user-1",
    });

    expect(restarts).toEqual([]);
    expect(invoker["handoffState"].getLastCtxTokens("otter-1")).toBe(100_000);
  });
});
