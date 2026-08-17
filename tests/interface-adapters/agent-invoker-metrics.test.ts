import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { AgentInvokePort, AgentStreamEvent } from "@interface-adapters/agent-runtime/agent-invoke-port";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentMetricsPort, InvokeOutcomeRecord, RetryKind } from "@usecases/ports/agent-metrics-port";
import type { Message } from "@entities/conversation/message";
import { runWithTrace } from "@usecases/ports/trace-context";
import { createTestLogger } from "../helpers/logger";

/** F20260814mtrc：AgentInvoker 埋点行为测试（metrics spy） */

function metricsSpy() {
  const invokes: InvokeOutcomeRecord[] = [];
  const retries: RetryKind[] = [];
  const guardAborts: Array<{ model: string; reason: string }> = [];
  const toolCalls: string[] = [];
  const toolDurations: Array<{ tool: string; ms: number }> = [];
  const toolErrors: string[] = [];
  const compactions: Array<{ reason: string; aborted: boolean }> = [];
  const sessionRebuilds: number[] = [];
  return {
    port: {
      recordInvoke: (r: InvokeOutcomeRecord) => invokes.push(r),
      recordRetry: (k: RetryKind) => retries.push(k),
      recordGuardAbort: (model: string, reason: string) => guardAborts.push({ model, reason }),
      recordToolCall: (tool: string) => toolCalls.push(tool),
      recordToolDuration: (tool: string, ms: number) => toolDurations.push({ tool, ms }),
      recordToolError: (tool: string) => toolErrors.push(tool),
      recordCompaction: (reason: string, aborted: boolean) => compactions.push({ reason, aborted }),
      recordSessionRebuild: () => sessionRebuilds.push(1),
      recordChainHops: () => {},
      recordChainDepthExceeded: () => {},
    } as AgentMetricsPort,
    invokes, retries, guardAborts, toolCalls, toolDurations, toolErrors, compactions, sessionRebuilds,
  };
}

const baseMsg = (status: Message["status"]): Message => ({
  id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
  senderType: "otter", senderId: "otter-1",
  talkingStonePassedTo: null, status,
  body: status === "speaking" ? "Body" : null,
  sequenceNum: 2, contextTokens: null, contextTokensMax: null,
  source: "web",
  createdAt: "2026-08-14T00:00:00Z", completedAt: null,
});

function mockSendMessage(): SendMessage {
  return {
    start: async () => baseMsg("streaming"),
    complete: async () => ({ message: baseMsg("completed"), turnClose: { closed: true, aggregatedTargets: ["user-1"] } }),
    fail: async () => ({}),
    abort: async () => ({}),
    appendEvent: async () => ({}),
    sendSystem: async () => baseMsg("completed"),
    updateTokenUsage: async () => ({}),
    prepareForRetry: async () => baseMsg("streaming"),
  } as unknown as SendMessage;
}

function makeInvoker(opts: {
  metrics: ReturnType<typeof metricsSpy>["port"];
  invokeResult?: Record<string, unknown>;
  throwOnInvoke?: Error;
  /** throwOnInvoke 的 guard 原因；null = 无 guard（纯 api_error） */
  guardReason?: string | null;
  /** err 路径透传的模型别名（pi-session-factory catch 分支行为模拟） */
  errModelAlias?: string;
  events?: AgentStreamEvent[];
  msgStatus: Message["status"];
}): AgentInvoker {
  const agentInvoke: AgentInvokePort = {
    invoke: async (_otterId: string, _msg: string, options?: { onEvent?: (e: AgentStreamEvent) => void }) => {
      if (opts.throwOnInvoke) {
        const e = opts.throwOnInvoke as Error & { _guardAbortReason?: string; _modelAlias?: string };
        const guardReason = opts.guardReason === undefined ? "degenerate_output" : opts.guardReason;
        if (guardReason !== null) e._guardAbortReason = guardReason;
        if (opts.errModelAlias) e._modelAlias = opts.errModelAlias;
        throw opts.throwOnInvoke;
      }
      for (const e of opts.events ?? []) options?.onEvent?.(e);
      return { text: "ok", ...opts.invokeResult };
    },
    abort: () => {},
    getToolCallCount: () => 0,
    getInternalAbortReason: () => undefined,
  };
  return new AgentInvoker(
    agentInvoke,
    mockSendMessage(),
    { getMessageById: async () => baseMsg(opts.msgStatus) } as unknown as QueryMessage,
    {
      getActiveSession: async () => null,
      createSession: async () => null,
    } as unknown as ManageSession,
    { getById: async () => ({ id: "otter-1", name: "Otter", type: "big" }) } as unknown as QueryOtter,
    createTestLogger(),
    undefined, undefined, undefined,
    opts.metrics,
  );
}

describe("AgentInvoker metrics 埋点（F20260814mtrc）", () => {
  it("成功路径：outcome=success + token/ctx/firstByte/sessionRebuild + 工具事件", async () => {
    const spy = metricsSpy();
    const invoker = makeInvoker({
      metrics: spy.port,
      msgStatus: "speaking",
      events: [
        { type: "tool_execution_start", name: "search_memory", toolCallId: "tc-1" },
        { type: "tool_execution_end", name: "search_memory", toolCallId: "tc-1", isError: false },
        { type: "tool_execution_end", name: "bash", toolCallId: "tc-2", isError: true },
        { type: "auto_retry_start", attempt: 1 },
        { type: "compaction_end", reason: "token_limit", aborted: false },
      ],
      invokeResult: {
        tokenUsage: { input: 100, output: 20 },
        ctxTokens: 42_000,
        modelAlias: "mimo",
        sessionRebuilt: true,
        outputGuardMetadata: { totalLength: 10, tripped: false, firstByteLatencyMs: 700 },
      },
    });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(spy.invokes).toHaveLength(1);
    expect(spy.invokes[0]).toMatchObject({
      model: "mimo", otterType: "big", source: "direct",
      outcome: "success", retry: "0",
      tokenUsage: { input: 100, output: 20 },
      ctxTokens: 42_000,
      firstByteLatencyMs: 700,
    });
    expect(spy.sessionRebuilds).toHaveLength(1);
    expect(spy.toolCalls).toEqual(["search_memory"]);
    expect(spy.toolDurations).toHaveLength(1);
    expect(spy.toolErrors).toEqual(["bash"]);
    expect(spy.retries).toContain("sdk_auto");
    expect(spy.compactions).toEqual([{ reason: "token_limit", aborted: false }]);
  });

  it("no_speak 路径：首轮 no_speak_retry + 重试计数，重试轮 no_speak_failed", async () => {
    const spy = metricsSpy();
    const invoker = makeInvoker({
      metrics: spy.port,
      msgStatus: "streaming", // 未 speaking → no_speak 分类
      invokeResult: { text: "no speak here" },
    });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(spy.invokes.map(i => i.outcome)).toEqual(["no_speak_retry", "no_speak_failed"]);
    expect(spy.invokes[1].retry).toBe("auto");
    expect(spy.retries).toContain("no_speak");
  });

  it("user_abort 路径（abortTerminal）：outcome=user_abort，恰好一次", async () => {
    const spy = metricsSpy();
    const invoker = makeInvoker({
      metrics: spy.port,
      msgStatus: "aborted",
      throwOnInvoke: new Error("user abort"),
      guardReason: null,
    });
    invoker.abort("otter-1", "msg-streaming");

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(spy.invokes.map(i => i.outcome)).toEqual(["user_abort"]);
  });

  it("user_abort + 消息已 speaking：收尾路径也记 user_abort，不漏不重（PR 审视修复）", async () => {
    const spy = metricsSpy();
    const invoker = makeInvoker({
      metrics: spy.port,
      msgStatus: "speaking", // speak 已交付 body，但 invoke 被用户中断
      throwOnInvoke: new Error("user abort"),
      guardReason: null,
      errModelAlias: "mimo",
    });
    invoker.abort("otter-1", "msg-streaming");

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(spy.invokes.map(i => i.outcome)).toEqual(["user_abort"]);
    expect(spy.invokes[0].model).toBe("mimo"); // err 路径 model 回退
  });

  it("api_error 路径：无 guard 原因的 throw → outcome=api_error", async () => {
    const spy = metricsSpy();
    const invoker = makeInvoker({
      metrics: spy.port,
      msgStatus: "streaming",
      throwOnInvoke: new Error("LLM API error"),
      guardReason: null,
      errModelAlias: "mimo",
    });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(spy.invokes.map(i => i.outcome)).toEqual(["api_error"]);
    expect(spy.invokes[0].model).toBe("mimo"); // err 路径 model 回退（PR 审视 P1 修复）
  });

  it("guard_abort 路径：序列恰为 [guard_abort, guard_abort]，err 路径 model 不落 unknown", async () => {
    const spy = metricsSpy();
    const invoker = makeInvoker({
      metrics: spy.port,
      msgStatus: "streaming",
      throwOnInvoke: new Error("guard"),
      guardReason: "degenerate_output",
      errModelAlias: "mimo",
    });

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(spy.invokes.map(i => i.outcome)).toEqual(["guard_abort", "guard_abort"]);
    expect(spy.invokes[0].retry).toBe("0");
    expect(spy.invokes[1].retry).toBe("auto"); // degenerate 重试轮
    expect(spy.invokes.every(i => i.model === "mimo")).toBe(true);
    expect(spy.guardAborts.map(g => g.reason)).toEqual(["degenerate_output", "degenerate_output"]);
    expect(spy.retries).toContain("degenerate_output");
  });

  it("路由阶段抛错 → catch 重入 classifyAndRoute：attempt 去重，不产生虚假 api_error（PR 审视 P0-1）", async () => {
    const spy = metricsSpy();
    let thrownOnce = false;
    const invoker = makeInvoker({
      metrics: spy.port,
      msgStatus: "streaming",
      invokeResult: { text: "no speak" }, // 两轮都 no_speak，触发 seamless 重试
    });

    /**
     * P0-1 场景：attempt2 已按 no_speak_failed 记录后，handleSpeakRetry 的
     * 第二次失败 emitEvent(message.failed) 抛错 → retryInvokeOnSameMessage 的
     * catch 重入 classifyAndRoute —— 去重键应阻止 attempt2 被再次记录为 api_error。
     */
    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
      onSSEEvent: (e) => {
        if (e.event === "message.failed" && !thrownOnce) {
          thrownOnce = true;
          throw new Error("SSE downstream failure");
        }
      },
    });

    /** 恰好两条：attempt1 no_speak_retry + attempt2 no_speak_failed；无虚假 api_error */
    expect(spy.invokes.map(i => i.outcome)).toEqual(["no_speak_retry", "no_speak_failed"]);
    expect(spy.invokes[1].retry).toBe("auto");
    expect(spy.retries).toContain("no_speak");
  });

  it("链级 trace 下 source=chain；手动重试 retry=manual", async () => {
    const spy = metricsSpy();
    const invoker = makeInvoker({ metrics: spy.port, msgStatus: "speaking" });

    await runWithTrace({ traceId: "t_chain1", source: "chain" }, () =>
      invoker.invokeConversation({
        otterId: "otter-1", conversationId: "conv-1",
        userMessageContent: "Hi", senderId: "user-1",
      }));
    expect(spy.invokes[0].source).toBe("chain");

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
      retryCount: 1, manualRetry: true,
    });
    expect(spy.invokes[1].source).toBe("direct");
    expect(spy.invokes[1].retry).toBe("manual");
  });
});
