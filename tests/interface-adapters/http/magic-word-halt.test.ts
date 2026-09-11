/**
 * Magic Word「停下」全场急停测试（F20260910ctlv test12：系统级 halt，不依赖 LLM 自觉）。
 *
 * 行为（大獭指令口径）：user 消息 body 含「停下」→ POST sendMessage 返回
 * 202 { status: 'halted', halted }，对全部 running invoke 调 agentInvoker.abort，
 * 消息不落库不点火。子串包含即命中（宽于 L2 reminder 扫描——系统级 halt 是
 * 硬动作，test12 案发原话「哎，你们停下吧」必须命中；误报损失 = 可重试的中断）。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { SendMessage } from "@usecases/conversation/send-message";
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
    {} as unknown as SendMessage,
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
});
