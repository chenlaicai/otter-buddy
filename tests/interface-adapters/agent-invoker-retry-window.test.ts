/**
 * #764 审视 A3：retry 观测窗写入侧覆盖（auto_retry_start/end → Map → 归因）。
 *
 * r1 只有 orchestrator 侧 stub getRetryErrorMessage——「auto_retry_start 事件 → 守卫
 * → Map set/get」捕获链零驱动。本测试走真实 AgentInvoker.invokeConversation：
 * mock SDK 在 invoke 内回放事件序列（onEvent 回调），断言观测窗生命周期三分支：
 * 1. auto_retry_start 捕获 + backoff 中 abort → 归因文案带底层错误
 * 2. auto_retry_start 后 auto_retry_end(success=true) 清窗 → 之后 abort 不带归因（S1 陈旧归因防线）
 * 3. auto_retry_end(success:false)（abort 打断 backoff）不清窗 → 归因保留（防误清）
 */

import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SdkInvokePort } from "@usecases/ports/sdk-invoke-port";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { OtterSession } from "@entities/otter/otter-session";
import { createTestLogger } from "../helpers/logger";
import { mockSendEntry } from "../helpers/mock-send-entry";

let invokerRef: AgentInvoker | undefined;

const RETRY_429 = 'LLM API error: 429 {"code":"1302","message":"rate limit exceeded"}';
const ABORT_OWN = new Error("LLM API error: Request aborted");

function mockQueryMessage(): QueryMessage {
  return { getMessageById: async () => null, getMessages: async () => [], getLastMessageBySenderType: async () => null } as unknown as QueryMessage;
}
function mockManageSession(): ManageSession {
  return {
    getActiveSession: async () => null,
    createSession: async (otterId: string) => ({
      id: "sess-1", otterId, status: "active", previousSessionId: null,
      startedAt: "2026-09-22T00:00:00Z", archivedAt: null, archiveReason: null,
      isNegativeCase: false, summary: null, modelAlias: null,
    } as OtterSession),
  } as unknown as ManageSession;
}
function mockQueryOtter(): QueryOtter {
  return {
    getById: async (id: string) => ({ id, name: "小獭", type: "small", status: "active", role: null, parentOtterId: null, createdAt: "2026-09-22T00:00:00Z", dissolvedAt: null }),
  } as unknown as QueryOtter;
}

/** SDK mock：回放给定事件序列后抛 abort 自身产物（err 通道无底层错误=backoff-abort 现场） */
function makeBackoffAbortSdk(events: Array<Record<string, unknown>>): SdkInvokePort {
  return {
    invoke: async (_otterId: string, _msg: string, opts?: { onEvent?: (e: unknown) => void; messageId?: string }) => {
      for (const e of events) opts?.onEvent?.(e);
      // 用户 backoff 中点中断：真实链路经 AgentInvoker.abort 标记 userAbortedMessages
      invokerRef?.abort(_otterId, opts?.messageId ?? "");
      throw ABORT_OWN;
    },
    abort: () => {},
    getToolCallCount: () => 0,
    getInternalAbortReason: () => undefined,
  } as unknown as SdkInvokePort;
}

function makeInvoker(sdk: SdkInvokePort, sendEntry: ReturnType<typeof mockSendEntry>): AgentInvoker {
  return new AgentInvoker(
    sdk, mockQueryMessage(), mockManageSession(), mockQueryOtter(), createTestLogger(),
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined,
    sendEntry,
    { getInvokeEvents: async () => [] } as never,
  );
}

/** 跑一轮 invokeConversation 并返回 invoke_end entry 的 body */
async function runAndGetAbortBody(sdk: SdkInvokePort): Promise<string> {
  const sendEntry = mockSendEntry();
  const invoker = makeInvoker(sdk, sendEntry);
  invokerRef = invoker;
  await invoker.invokeConversation({
    otterId: "otter-1", conversationId: "conv-1", userMessageContent: "Hi", senderId: "user-1",
  });
  const endCall = sendEntry.store.invokeEndCalls.find((c) => c.status === "aborted");
  expect(endCall).toBeDefined();
  return endCall!.body ?? "";
}

describe("#764 retry 观测窗生命周期（auto_retry 事件驱动真实 AgentInvoker）", () => {
  it("auto_retry_start 捕获 + backoff 中 abort → 归因文案带底层错误 429", async () => {
    const sdk = makeBackoffAbortSdk([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 4, delayMs: 1000, errorMessage: RETRY_429 },
    ]);
    const body = await runAndGetAbortBody(sdk);
    expect(body).toContain("底层错误");
    expect(body).toContain("429");
  });

  it("S1 防线：auto_retry_end(success=true) 清窗后 abort → 不带陈旧 429 归因", async () => {
    const sdk = makeBackoffAbortSdk([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 4, delayMs: 1000, errorMessage: RETRY_429 },
      { type: "auto_retry_end", success: true, attempt: 1 }, // retry 成功恢复干活——观测窗应已清空
    ]);
    const body = await runAndGetAbortBody(sdk);
    expect(body).not.toContain("底层错误");
    expect(body).not.toContain("429");
  });

  it("auto_retry_end(success:false)（abort 打断 backoff）不清窗 → 归因保留", async () => {
    const sdk = makeBackoffAbortSdk([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 4, delayMs: 1000, errorMessage: RETRY_429 },
      { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
    ]);
    const body = await runAndGetAbortBody(sdk);
    expect(body).toContain("底层错误");
    expect(body).toContain("429");
  });
});
