import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Logger } from "@usecases/ports/logger";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";

/**
 * F20260924wast（S1）：HTTP sendMessage 链的 web 助理 session 检查测试。
 * 断言：kind=web-assistant 对话在 precheck 后、sendEntry 前调用
 * checkIdleAndRestartSession；kind=normal/assistant 对话不触发（严格限定）。
 * 副作用断言风格：sessionChecks 数组记录检查过的对话（行为结果），不绑 mock 调用次数。
 */
const logger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as unknown as Logger;

function makeHarness(conversationKind: "web-assistant" | "normal" | "assistant") {
  /** 副作用记录：session 检查命中的对话 id + 发送链是否走到落库 */
  const sessionChecks: string[] = [];
  const sentEntries: string[] = [];

  const ctrl = new MessageController(
    {} as never, // queryMessage
    {} as never, // manageReadState
    { invokeConversation: async () => ({ invokeId: "inv", aggregatedTargets: [] }) } as never,
    logger,
    {} as never, // queryOtter
    { executeChain: async () => ({}) } as never, // dispatchChainEngine
    undefined, undefined, undefined, undefined,
    {
      sendUserEntry: async () => {
        sentEntries.push("conv-1");
        return { entry: { id: "e-1", sequenceNum: 1, createdAt: new Date().toISOString(), body: "hi" }, talkingStonePassedTo: [] };
      },
    } as never,
    undefined, undefined,
    // F20260924wast：web 助理 session 检查
    { checkIdleAndRestartSession: async (id: string) => { sessionChecks.push(id); } },
    { getById: async () => ({ id: "conv-1", kind: conversationKind }) } as never,
  );

  const app = new Hono();
  app.post("/api/conversations/:id/messages", (c) => ctrl.sendMessage(c));
  return { app, sessionChecks, sentEntries };
}

async function post(app: Hono) {
  return app.request("/api/conversations/conv-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: [], body: "你好" }),
  });
}

describe("sendMessage 的 web 助理 session 检查（F20260924wast S1）", () => {
  it("kind=web-assistant → sendEntry 前调用 checkIdleAndRestartSession", async () => {
    const ctx = makeHarness("web-assistant");
    await post(ctx.app);

    expect(ctx.sessionChecks).toEqual(["conv-1"]);
    expect(ctx.sentEntries).toEqual(["conv-1"]);
  });

  it("kind=normal → 不触发（严格限定 web-assistant）", async () => {
    const ctx = makeHarness("normal");
    await post(ctx.app);
    expect(ctx.sessionChecks).toEqual([]);
    expect(ctx.sentEntries).toEqual(["conv-1"]);
  });

  it("kind=assistant → 不触发（IM 助理由 IM 入站链保证）", async () => {
    const ctx = makeHarness("assistant");
    await post(ctx.app);
    expect(ctx.sessionChecks).toEqual([]);
  });

  it("session 检查抛错不阻塞消息发送（失败只记日志）", async () => {
    const sentEntries: string[] = [];
    const ctrl = new MessageController(
      {} as never, {} as never,
      { invokeConversation: async () => ({ invokeId: "inv", aggregatedTargets: [] }) } as never,
      logger, {} as never,
      { executeChain: async () => ({}) } as never,
      undefined, undefined, undefined, undefined,
      {
        sendUserEntry: async () => {
          sentEntries.push("conv-1");
          return { entry: { id: "e-1", sequenceNum: 1, createdAt: "", body: "" }, talkingStonePassedTo: [] };
        },
      } as never,
      undefined, undefined,
      { checkIdleAndRestartSession: async () => { throw new Error("boom"); } },
      { getById: async () => ({ id: "conv-1", kind: "web-assistant" }) } as never,
    );
    const app = new Hono();
    app.post("/api/conversations/:id/messages", (c) => ctrl.sendMessage(c));

    const res = await post(app);
    // 消息继续走（sendEntry 被执行 = 未被 session 检查失败阻塞）
    expect(res.status).not.toBe(500);
    expect(sentEntries).toEqual(["conv-1"]);
  });
});
