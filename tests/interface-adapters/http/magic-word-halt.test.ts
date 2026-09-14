/**
 * Magic Word「停下」全场急停测试（F20260913ctlv test12：系统级 halt，不依赖 LLM 自觉）。
 *
 * 行为（搭档拍板严格口径「单用才生效」）：user 消息 body 去除句首语气/称呼
 * （哎/你们/快…）与句末语气词（吧/了…）后核心恰好是「停下」→ POST sendMessage 返回
 * 202 { status: 'halted', halted }，对全部 running invoke 调 agentInvoker.abort，
 * 消息不落库不点火。整句即停手命令才命中；粘连文字/引用/片段不命中
 * （SYSTEM.md「引用/复述不触发」；系统级 halt 是硬动作，必须排除误伤）。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { ManageReadState } from "@usecases/conversation/manage-read-state";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { Logger } from "@usecases/ports/logger";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";

const logger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as unknown as Logger;

function makeHarness(runningInvokes: Array<{ id: string; otterId: string; status: string }>) {
  const abortCalls: Array<{ otterId: string; invokeId: string }> = [];
  const agentInvoker = {
    invokeConversation: async () => ({ invokeId: "inv-new", aggregatedTargets: [] }),
    abort: (otterId: string, invokeId: string) => { abortCalls.push({ otterId, invokeId }); },
  } as unknown as AgentInvoker;

  const dispatchChainEngine = { executeChain: async () => ({}) } as unknown as DispatchChainEngine;

  const sendUserEntry = vi.fn();
  const ctrl = new MessageController(
    {} as unknown as QueryMessage,
    {} as unknown as ManageReadState,
    agentInvoker,
    logger,
    {} as unknown as QueryOtter,
    dispatchChainEngine,
    undefined, // messageBroadcaster
    undefined, // signalRepo
    undefined, // attachmentInjection
    undefined, // signalRouter
    { sendUserEntry } as never, // sendEntry
    undefined, // settleEntryRepo
    { getInvokes: async (_convId: string, options?: { status?: string }) =>
      options?.status === "running" ? runningInvokes : [] } as never, // settleInvokeRepo
  );
  return { ctrl, abortCalls, sendUserEntry };
}

function post(app: Hono, body: string) {
  return app.request("/api/conversations/conv-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: [], body }),
  });
}

describe("Magic Word「停下」全场急停", () => {
  it("「哎，你们停下吧」命中（test12 案发原话）→ abort 全部 running invoke + 202 + 不落库不点火", async () => {
    const { ctrl, abortCalls, sendUserEntry } = makeHarness([
      { id: "inv-talk", otterId: "talk-1", status: "running" },
      { id: "inv-image", otterId: "image-1", status: "running" },
    ]);
    const app = new Hono();
    app.post("/api/conversations/:id/messages", (c) => ctrl.sendMessage(c));

    const res = await post(app, "哎，你们停下吧");

    expect(res.status).toBe(202);
    const json = await res.json() as { status: string; halted: number };
    expect(json.status).toBe("halted");
    expect(json.halted).toBe(2);
    // 两只 running 全被 abort（系统级 halt，不依赖目标解析选谁）
    expect(abortCalls).toEqual([
      { otterId: "talk-1", invokeId: "inv-talk" },
      { otterId: "image-1", invokeId: "inv-image" },
    ]);
    // 消息不落库不点火
    expect(sendUserEntry).not.toHaveBeenCalled();
  });

  it("「停下。」与裸「停下」均命中", async () => {
    for (const text of ["停下。", "停下"]) {
      const { ctrl } = makeHarness([]);
      const app = new Hono();
      app.post("/api/conversations/:id/messages", (c) => ctrl.sendMessage(c));
      const res = await post(app, text);
      expect(res.status).toBe(202);
    }
  });

  it("场上无 running invoke → 202 halted=0（急停幂等，无目标可停）", async () => {
    const { ctrl, abortCalls } = makeHarness([]);
    const app = new Hono();
    app.post("/api/conversations/:id/messages", (c) => ctrl.sendMessage(c));
    const res = await post(app, "停下");
    expect(res.status).toBe(202);
    const json = await res.json() as { halted: number };
    expect(json.halted).toBe(0);
    expect(abortCalls).toEqual([]);
  });

  it("普通消息不受影响（不含「停下」子串）", async () => {
    const { ctrl, abortCalls, sendUserEntry } = makeHarness([{ id: "inv-1", otterId: "a", status: "running" }]);
    const app = new Hono();
    app.post("/api/conversations/:id/messages", (c) => ctrl.sendMessage(c));
    const res = await post(app, "在吗？帮我看下进度");
    expect(res.status).not.toBe(202);
    expect(abortCalls).toEqual([]);
    expect(sendUserEntry).toHaveBeenCalled();
  });

  it("严格口径：粘连文字/引用/片段不命中（单用才生效）", async () => {
    const { ctrl, abortCalls, sendUserEntry } = makeHarness([{ id: "inv-1", otterId: "a", status: "running" }]);
    const app = new Hono();
    app.post("/api/conversations/:id/messages", (c) => ctrl.sendMessage(c));
    // 「停下」粘连其他文字或作引用——非整句停手命令，不触发急停
    for (const text of ["别停下手头工作", "我们讨论停下一词", "停下来的感觉", "先停下再说话", "这个词叫停下", "请你们停下手里的活"]) {
      const res = await post(app, text);
      expect(res.status, `「${text}」不应命中`).not.toBe(202);
    }
    expect(abortCalls).toEqual([]);
    // 副作用断言：6 条引用/粘连消息全部走了正常发言路径（未触发 202 急停）
    expect(sendUserEntry).toHaveBeenCalled();
    expect(sendUserEntry.mock.calls.length).toBe(6);
  });

  it("严格口径：语气/称呼包装后仍命中（整句即停手命令）", async () => {
    for (const text of ["快停下", "都停下。", "喂，快停下！", "大家停下吧"]) {
      const { ctrl, abortCalls } = makeHarness([{ id: "inv-1", otterId: "a", status: "running" }]);
      const app = new Hono();
      app.post("/api/conversations/:id/messages", (c) => ctrl.sendMessage(c));
      const res = await post(app, text);
      expect(res.status, `「${text}」应命中`).toBe(202);
      expect(abortCalls.length).toBeGreaterThan(0);
    }
  });
});
