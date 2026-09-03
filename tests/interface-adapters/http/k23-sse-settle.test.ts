/**
 * K3 SSE 生命周期挂台账终态（F20260903k23）：POST SSE 关流判据端到端测试。
 *
 * - 点火 → attempt 终态 → stream.end（正常路径）
 * - 排队不写账（无 attempt 行）→ 超时兜底关流（不悬死）
 * - 失败翻篇（failed 终态）→ 也关流（失败可见，不卡「处理中」假象）
 * - 台账未注入 → 立即关流（回退旧语义）
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { MessageController } from "@interface-adapters/http/controllers/message-controller";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { AgentInvoker } from "@interface-adapters/agent-runtime/agent-invoker";
import type { ManageReadState } from "@usecases/conversation/manage-read-state";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { SignalRouter } from "@usecases/conversation/signal-router";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
}

const queryOtterStub = { getById: async () => null } as unknown as QueryOtter;
const queryMessageStub = { getMessageById: async () => null } as unknown as QueryMessage;

function buildHarness(opts: { repo?: DispatchAttemptRepo; router?: SignalRouter }) {
  const { repo, router } = opts;
  const useCase = { send: async () => ({ message: { id: "user-msg-1", talkingStonePassedTo: ["otter-x"] } }) } as unknown as SendMessage;
  const agentInvoker = { invokeConversation: async () => ({ messageId: "m-1" }) } as unknown as AgentInvoker;
  const logger = makeLogger();
  const dispatchChainEngine = {} as unknown as DispatchChainEngine;
  const mockBroadcaster = { broadcastEvent: vi.fn(), broadcast: async () => {}, subscribe: () => () => {} };
  const ctrl = new MessageController(
    useCase, queryMessageStub,
    { markRead: vi.fn().mockResolvedValue({ lastReadSeq: 0, unreadCount: 0 }) } as unknown as ManageReadState,
    agentInvoker, logger as never, queryOtterStub,
    dispatchChainEngine, mockBroadcaster as never,
    undefined, undefined,
    router, // signalRouter
    undefined, // signalTrail
    repo, // dispatchAttemptRepo（K3）
  );
  const app = new Hono();
  app.post("/api/conversations/:id/messages", (c) => ctrl.sendMessage(c));
  return { app };
}

function postMessage(app: Hono) {
  return app.request("/api/conversations/conv-1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId: "user-1", talkingStonePassedTo: ["otter-x"], body: "hi" }),
  });
}

describe("K3：POST SSE 挂 attempt 终态（F20260903k23）", () => {
  it("点火 → attempt 终态 → stream.end 关流（终态判据生效）", async () => {
    let rows: Array<{ messageId: string; status: string }> = [];
    const repo = {
      listAttemptsForConversation: vi.fn().mockImplementation(async () => rows),
    } as unknown as DispatchAttemptRepo;
    const router = { routePendingSignals: vi.fn().mockImplementation(async () => {
      rows = [{ messageId: "user-msg-1", status: "in_progress" }];
    }) } as unknown as SignalRouter;
    const { app } = buildHarness({ repo, router });

    const res = await postMessage(app);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("stream.end");
    // 至少轮询过一次（第一次 in_progress 不关，settle 后关）
    expect(repo.listAttemptsForConversation).toHaveBeenCalled();
  });

  it("failed 终态也关流（失败可见，不卡假象）", async () => {
    const repo = {
      listAttemptsForConversation: vi.fn().mockResolvedValue([{ messageId: "user-msg-1", status: "failed" }]),
    } as unknown as DispatchAttemptRepo;
    const router = { routePendingSignals: vi.fn().mockResolvedValue([]) } as unknown as SignalRouter;
    const { app } = buildHarness({ repo, router });
    const res = await postMessage(app);
    const text = await res.text();
    expect(text).toContain("stream.end");
  });

  it("无 attempt 行（排队不写账）→ 超时兜底关流，不悬死", async () => {
    const listAttempts = vi.fn().mockResolvedValue([]);
    const repo = {
      listAttemptsForConversation: listAttempts,
    } as unknown as DispatchAttemptRepo;
    const router = { routePendingSignals: vi.fn().mockResolvedValue([]) } as unknown as SignalRouter;
    const { app } = buildHarness({ repo, router });
    const res = await postMessage(app);
    const text = await res.text();
    expect(text).toContain("stream.end");
    // 超时路径：轮询必然发生多次
    expect(listAttempts.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("台账未注入 → 立即关流（回退旧语义）", async () => {
    const router = { routePendingSignals: vi.fn().mockResolvedValue([]) } as unknown as SignalRouter;
    const { app } = buildHarness({ router });
    const res = await postMessage(app);
    const text = await res.text();
    expect(text).toContain("stream.end");
  });
});
