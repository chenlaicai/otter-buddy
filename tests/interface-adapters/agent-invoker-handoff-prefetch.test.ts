/**
 * F20260901mbfx：agent-invoker 交接谱系/预取机械查询测试
 *
 * 覆盖 resolveHandoffLineage（谱系提取）与 buildSynthesisPrefetch（枚举事实预取）
 * 经由 handleHandoff 路径的行为：mock manageSession/listArtifacts/manageContext，
 * 断言 buildHandoffPkg 收到的 options 携带正确机械数据。
 *
 * 断言策略（D7）：只验证注入 options 的数据形态，不测内部方法。
 */
import { describe, it, expect } from "vitest";
import { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageSession } from "@usecases/otter/manage-session";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Message } from "@entities/conversation/message";
import { createTestLogger } from "../helpers/logger";

const baseMsg = (status: Message["status"]): Message => ({
  id: "msg-streaming", conversationId: "conv-1", turnId: "turn-1",
  senderType: "otter", senderId: "otter-1",
  talkingStonePassedTo: null, status,
  segments: status === "speaking" ? [{ id: "seg-1", messageId: "msg-streaming", body: "Body", sequenceNum: 1, createdAt: "2026-08-14T00:00:00Z" }] : [],
  sequenceNum: 2, contextTokens: null, contextTokensMax: null,
  source: "web",
  senderName: "Test Otter",
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

/** 触发 handleHandoff（pre-invoke 70% 阈值）并捕获 buildHandoffPkg 收到的 options */
async function runHandoffCapture(opts: {
  activeSession: { id: string; summary: string | null } | null;
  contextData?: Record<string, string>;
  artifacts?: Array<{ id: string; resourceType: string; title?: string; status?: string }>;
  userMessages?: string[];
}): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;

  const queryMessage = {
    getMessageById: async () => ({ ...baseMsg("completed"), contextTokens: 100_000 }),
    getMessages: async (_convId: string, options?: { senderType?: string; limit?: number }) => {
      if (options?.senderType === 'user') {
        // 模拟 repo 倒序返回，代码内 reverse 恢复正序
        return [...(opts.userMessages ?? [])].map((body, i) => ({ ...baseMsg("completed"), id: `umsg-${i}`, segments: [{ id: `seg-${i}`, messageId: `umsg-${i}`, body, sequenceNum: 1, createdAt: "2026-09-01T00:00:00Z" }] })).reverse();
      }
      return [];
    },
  } as unknown as QueryMessage;

  const manageSession = {
    getActiveSession: async () => opts.activeSession,
    createSession: async () => null,
  } as unknown as ManageSession;

  const invoker = new AgentInvoker(
    // 1-6：必选依赖
    {
      invoke: async () => ({ text: "ok" }),
      abort: () => {},
      getToolCallCount: () => 0,
      getInternalAbortReason: () => undefined,
    },
    mockSendMessage(),
    queryMessage,
    manageSession,
    { getById: async () => ({ id: "otter-1", name: "Otter", type: "big" }) } as unknown as QueryOtter,
    createTestLogger(),
    // 7-12：可选依赖（broadcaster/workspace/settings/metrics/healingRepo/conversationRepo）
    undefined, undefined, undefined, undefined, undefined,
    {} as never, // 11：conversationRepo（handleHandoff 显式守卫要求非空，mock 空对象即可）
    // 13：scheduledTaskRepo
    undefined,
    // 14：listArtifacts
    opts.artifacts !== undefined ? async () => opts.artifacts as never : undefined,
    // 15：manageContext
    opts.contextData !== undefined ? { get: async () => opts.contextData } as never : undefined,
    // 16：buildHandoffPkg（捕获 options）
    (async (_convId: string, _otterId: string, options: Record<string, unknown>) => {
      captured = options;
      return { summary: "dump", context: "", stateInventoryText: "", meta: {} };
    }) as unknown as typeof import("@frameworks/agent/handoff-package-builder").buildHandoffPackage,
    // 17-18：threshold / ctxWindowProvider
    undefined, undefined,
  );

  const call = () => invoker.invokeConversation({
    conversationId: "conv-1",
    otterId: "otter-1",
    userMessageContent: "Hi",
    senderId: "user-1",
  });
  await call(); // 第一轮：post-turn 记录 ctxTokens
  // F20260903cmpk：70% Pre-invoke 阈值链路退役，直调 handleHandoff 驱动捕获
  await (invoker as unknown as { handleHandoff: (otterId: string, conversationId: string) => Promise<void> }).handleHandoff("otter-1", "conv-1");

  return captured;
}

describe("AgentInvoker 交接谱系/预取机械查询（F20260901mbfx）", () => {
  it("旧 summary 含谱系行时：oldSessionId + lineage 机械注入 buildHandoffPkg", async () => {
    const captured = await runHandoffCapture({
      activeSession: {
        id: "real-session-id-1",
        summary: "## 交接摘要\n### ⑦ 交接谱系\n- gen1 aaaabbbb: 审计分析\n- gen2 ccccdddd: 修复实施\n\n其他叙事段落",
      },
    });

    expect(captured).not.toBeNull();
    expect(captured!.oldSessionId).toBe("real-session-id-1");
    expect(captured!.lineage).toBe("- gen1 aaaabbbb: 审计分析\n- gen2 ccccdddd: 修复实施");
  });

  it("旧 summary 无谱系标记时：lineage undefined（新代 gen1 重建）", async () => {
    const captured = await runHandoffCapture({
      activeSession: { id: "real-session-id-2", summary: "纯叙事摘要，无谱系标记" },
    });

    expect(captured).not.toBeNull();
    expect(captured!.oldSessionId).toBe("real-session-id-2");
    expect(captured!.lineage).toBeUndefined();
  });

  it("prefetch 聚合：context keys + active 产物 + 搭档消息（正序）", async () => {
    const captured = await runHandoffCapture({
      activeSession: { id: "real-session-id-3", summary: null },
      contextData: { task_status: "修复中", next_step: "测试" },
      artifacts: [
        { id: "res-active1", resourceType: "pr", title: "边界修复", status: "active" },
        { id: "res-super1", resourceType: "file", status: "superseded" },
      ],
      userMessages: ["第一条指令", "第二条指令"],
    });

    expect(captured).not.toBeNull();
    const prefetch = captured!.prefetch as {
      contextKeys: string[];
      activeArtifacts: Array<{ id: string }>;
      recentUserMessages?: string[];
    };
    expect(prefetch.contextKeys).toEqual(["task_status", "next_step"]);
    // superseded 产物被过滤
    expect(prefetch.activeArtifacts.map(a => a.id)).toEqual(["res-active1"]);
    expect(prefetch.recentUserMessages).toEqual(["第一条指令", "第二条指令"]);
  });

  it("无数据时 prefetch 仍传空壳（区分'查过没有'与'没查'），userMessages 空时不带字段", async () => {
    const captured = await runHandoffCapture({
      activeSession: { id: "real-session-id-4", summary: null },
    });

    expect(captured).not.toBeNull();
    const prefetch = captured!.prefetch as {
      contextKeys: string[];
      activeArtifacts: Array<{ id: string }>;
      recentUserMessages?: string[];
    };
    // 查询成功但结果为空：传空数组（prompt 端渲染为'（空）'/'无'，与'可用只读工具自查'区分）
    expect(prefetch.contextKeys).toEqual([]);
    expect(prefetch.activeArtifacts).toEqual([]);
    // userMessages 空：不携带该字段（fallback 文案引导 LLM 自行识别）
    expect(prefetch.recentUserMessages).toBeUndefined();
  });
});
