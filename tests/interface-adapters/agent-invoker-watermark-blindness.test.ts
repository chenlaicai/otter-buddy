/**
 * F20260922wbfx：水位失明修复的失败证据固化（先写失败测试，再修）。
 *
 * 事故（9/22 排查报告）：《issue处理》大獭 kimi-256k 每轮 ctx 84k+ 已超 handoffThreshold 40k，
 * 但水位交接从未触发（全日志 watermark exceeded = 0）；18:40 SDK 压缩失败无人感知；
 * 19:00 两次重试开口即截断 → no_yield 死循环，失败文案「未调用 yield」完全误导。
 *
 * 本测试固化三条失败形态（修复前必须全红）：
 * 1. 失败路径（no_yield 耗尽）ctxTokens 不写回 handoffState —— 防线失明
 * 2. compaction_end 带 errorMessage 时无任何 warn/上浮 —— SDK 呼救无人听
 * 3. no_yield 失败文案不区分 length 截断与普通未 yield —— 死因误导
 */
import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort, AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import { createTestLogger, createCapturingLogger } from "../helpers/logger";
import { mockSendEntry } from "../helpers/mock-send-entry";
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

function mockManageSession(): ManageSession {
  return {
    getActiveSession: async () => null,
    createSession: async (otterId: string) => makeSession({ id: "sess-backfill", otterId }),
    restartSession: async (otterId: string) => makeSession({ id: "sess-new", otterId }),
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

/** 捕获 warn 级日志的 logger（断点2 验证用：compaction 失败必须 warn 上浮） */
function makeCapturingLogger(): { logger: Logger; warns: string[] } {
  const logger = createCapturingLogger();
  return { logger, warns: logger.captured.warns };
}

function mockAgentInvokeNoYield(opts: {
  ctxTokens?: number;
  lastStopReason?: string;
  compactionEvents?: AgentStreamEvent[];
}): SdkInvokePort {
  const invokeImpl = async (_o: string, _m: string, callOpts?: { onEvent?: (e: AgentStreamEvent) => void }) => {
    for (const evt of opts.compactionEvents ?? []) {
      callOpts?.onEvent?.(evt);
    }
    // no_yield：返回文本但永不 yield；带 ctxTokens（模型确实跑了）+ lastStopReason
    return {
      text: "",
      tokenUsage: { input: 100, output: 50 },
      ctxTokens: opts.ctxTokens,
      ...(opts.lastStopReason ? { lastStopReason: opts.lastStopReason } : {}),
    };
  };
  return {
    invoke: invokeImpl,
    abort: () => {},
    getToolCallCount: () => 0,
    getInternalAbortReason: () => undefined,
  } as unknown as SdkInvokePort;
}

function makeInvoker(sdk: SdkInvokePort, logger?: Logger) {
  const sendEntry = mockSendEntry();
  const invoker = new AgentInvoker(
    sdk,
    mockQueryMessage(),
    mockManageSession(),
    mockQueryOtter(),
    logger ?? createTestLogger(),
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    { getOtterContextWindow: () => 262_144, getOtterHandoffThresholdTokens: () => 40_000 } as never,
    sendEntry,
    { getInvokeEvents: async () => [] } as never,
  );
  return { invoker, sendEntry };
}

describe("水位失明修复失败证据（F20260922wbfx）", () => {
  it("断点1：no_yield 耗尽 failed 路径也写回 ctxTokens（防线看得见失败轮的 261k）", async () => {
    const sdk = mockAgentInvokeNoYield({ ctxTokens: 261_550 });
    const { invoker, sendEntry } = makeInvoker(sdk);

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    // 确认走的是失败路径
    const invoke = [...sendEntry.store.invokes.values()][0]!;
    expect(invoke.status).toBe("failed");
    // 失败轮的 ctxTokens 必须写回——否则下轮水位判定 last=undefined 静默跳过
    expect(invoker["handoffState"].getLastCtxTokens("otter-1")).toBe(261_550);
  });

  it("断点2：compaction_end 携带 errorMessage → logger.warn 上浮（SDK 呼救有人听）", async () => {
    const { logger, warns } = makeCapturingLogger();
    const sdk = mockAgentInvokeNoYield({
      ctxTokens: 100_000,
      compactionEvents: [
        { type: "compaction_start", reason: "threshold" } as unknown as AgentStreamEvent,
        {
          type: "compaction_end",
          reason: "threshold",
          aborted: false,
          willRetry: false,
          errorMessage: "Auto-compaction failed: Summarization failed: generation hit the token cap",
        } as unknown as AgentStreamEvent,
      ],
    });
    const { invoker } = makeInvoker(sdk, logger);

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    expect(warns.some(m => m.includes("ompaction") && m.includes("failed"))).toBe(true);
  });

  it("断点3：no_yield 耗尽 + lastStopReason=length → 失败文案写明截断而非「未调用 yield」", async () => {
    const sdk = mockAgentInvokeNoYield({ ctxTokens: 261_550, lastStopReason: "length" });
    const { invoker, sendEntry } = makeInvoker(sdk);

    await invoker.invokeConversation({
      otterId: "otter-1", conversationId: "conv-1",
      userMessageContent: "Hi", senderId: "user-1",
    });

    const endEntry = sendEntry.store.invokeEndCalls.find(c => c.status === "failed");
    expect(endEntry).toBeDefined();
    // 文案必须暴露真实死因（截断），不能只有误导性的「未调用 yield」
    expect(endEntry!.body).toMatch(/截断|length|token/);
  });
});
