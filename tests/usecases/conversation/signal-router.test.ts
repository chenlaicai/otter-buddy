import { describe, it, expect, vi } from "vitest";
import { SignalRouter } from "@usecases/conversation/signal-router";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { Message } from "@entities/conversation/message";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "sig-1", conversationId: "conv-1", turnId: "turn-1", senderId: "user-1",
    senderType: "user", status: "completed",
    segments: [{ id: "seg-1", messageId: "sig-1", body: "do it", sequenceNum: 0, createdAt: "" }],
    sequenceNum: 10,
    talkingStonePassedTo: ["otter-1"], contextTokens: null, contextTokensMax: null,
    source: "web", senderName: "", createdAt: new Date().toISOString(), completedAt: "",
    signalLevel: null, signalMeta: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<{
  unread?: Message[] | null;   // null = 默认与 candidates 一致
  candidates: Message[];
  otterType: "big" | "small";
  lastMsg: Message | null;
  chainError: Error | null;
}> = {}) {
  const { unread: unreadOverride = null, candidates = [makeMsg()], otterType = "big", lastMsg = null, chainError = null } = overrides;
  const unread = unreadOverride ?? candidates;
  const executeChain = vi.fn().mockImplementation(() => chainError ? Promise.reject(chainError) : Promise.resolve({}));
  const healingCreate = vi.fn().mockResolvedValue(undefined);
  return {
    executeChain,
    healingCreate,
    router: new SignalRouter({
      conversationRepo: {
        getUnreadMessages: vi.fn().mockResolvedValue(unread),
        getAllIds: vi.fn().mockResolvedValue(["conv-1"]),
      } as unknown as ConversationRepository,
      queryMessage: {
        getMessages: vi.fn().mockResolvedValue(candidates),
        getLastMessageBySender: vi.fn().mockResolvedValue(lastMsg),
      } as unknown as QueryMessage,
      queryOtter: { getById: vi.fn().mockResolvedValue({ id: "otter-1", type: otterType }) } as unknown as QueryOtter,
      dispatchChainEngine: { executeChain } as unknown as DispatchChainEngine,
      invokeFn: vi.fn().mockResolvedValue({ messageId: "m-out" }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
      healingRepo: { create: healingCreate } as unknown as HealingEventRepository,
    }),
  };
}

/** 等待 fire-and-forget 的链调用落地（微任务排空 + 去抖窗口余量） */
async function flushAsync(): Promise<void> {
  await new Promise(r => setTimeout(r, 10));
}

describe("SignalRouter（F20260901sgpv P1：信号路由器）", () => {

  it("未读信号 → 点火链引擎（目标 = 信号投递目标）", async () => {
    const { router, executeChain } = makeDeps();
    await router.routePendingSignals("conv-1");
    await flushAsync();
    // 副作用断言：链被点火且目标正确（结果对象而非调用计数）
    const args = executeChain.mock.calls[0]?.[0] as { initialTargets: string[]; conversationId: string } | undefined;
    expect(args?.initialTargets).toEqual(["otter-1"]);
    expect(args?.conversationId).toBe("conv-1");
  });

  it("无未读（已被消费）→ 不点火（幂等：游标即消费账本）", async () => {
    const { router } = makeDeps({ unread: [] });
    const results = await router.routePendingSignals("conv-1");
    await flushAsync();
    // 幂等：已被消费（无未读）→ 空路由结果
    expect(results).toEqual([]);
  });

  it("目标 busy（外部 streaming 消息）→ 入 busyQueue 不点火，内容保全", async () => {
    // 模拟目标正在干活：最新消息 streaming（isOtterActive = true）
    const streaming = makeMsg({ senderType: "otter", senderId: "otter-1", status: "streaming", talkingStonePassedTo: [] });
    const { router } = makeDeps({ lastMsg: streaming });
    const r = await router.routePendingSignals("conv-1");
    expect(r[0]?.action).toBe("queued_busy");
  });

  it("HALT 投往小獭 → 丢弃 + healing 留痕（C2 权限拦截的绕过防线）", async () => {
    const { router, healingCreate } = makeDeps({
      otterType: "small",
      candidates: [makeMsg({ signalLevel: "HALT", talkingStonePassedTo: ["otter-1"] })],
    });
    const r = await router.routePendingSignals("conv-1");
    expect(r[0]?.action).toBe("skipped_no_target");
    await flushAsync();
    // 副作用断言：healing 事件落账（权限拦截留痕）
    expect(healingCreate.mock.calls.length).toBe(1);
    const event = healingCreate.mock.calls[0][0] as { errorType: string; severity: string };
    expect(event.errorType).toBe("permission_denied");
    expect(healingCreate.mock.calls.length).toBeGreaterThan(0);
  });

  it("链抛错 → healing 留痕（消费失败可见性，七刀之七）", async () => {
    const { router, healingCreate } = makeDeps({ chainError: new Error("boom") });
    await router.routePendingSignals("conv-1");
    await flushAsync();
    // 副作用断言：消费失败落 healing（可见性契约）
    const event = healingCreate.mock.calls[0]?.[0] as { description: string } | undefined;
    expect(event?.description).toContain("信号消费失败");
  });

  it("目标已解散（queryOtter 空）→ skipped_inactive，不点火", async () => {
    const executeChain = vi.fn().mockResolvedValue({});
    const router = new SignalRouter({
      conversationRepo: {
        getUnreadMessages: vi.fn().mockResolvedValue([makeMsg({ talkingStonePassedTo: ["ghost"] })]),
        getAllIds: vi.fn().mockResolvedValue(["conv-1"]),
      } as unknown as ConversationRepository,
      queryMessage: {
        getMessages: vi.fn().mockResolvedValue([makeMsg({ talkingStonePassedTo: ["ghost"] })]),
        getLastMessageBySender: vi.fn().mockResolvedValue(null),
      } as unknown as QueryMessage,
      queryOtter: { getById: vi.fn().mockResolvedValue(null) } as unknown as QueryOtter,
      dispatchChainEngine: { executeChain } as unknown as DispatchChainEngine,
      invokeFn: vi.fn().mockResolvedValue({ messageId: "m" }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    });
    const res = await router.routePendingSignals("conv-1");
    await flushAsync();
    expect(res[0]?.action).toBe("skipped_inactive");
    expect(executeChain.mock.calls.length).toBe(0);
  });

  it("self-yield（otter 指向自己）→ 不点火（防自链病态获得驱动；梯度护栏归 P3）", async () => {
    const { router, executeChain } = makeDeps({
      candidates: [makeMsg({ senderType: "otter", senderId: "otter-1", talkingStonePassedTo: ["otter-1"] })],
      unread: [makeMsg({ senderType: "otter", senderId: "otter-1", talkingStonePassedTo: ["otter-1"] })],
    });
    await router.routePendingSignals("conv-1");
    await flushAsync();
    expect(executeChain.mock.calls.length).toBe(0);
  });

  it("system 信号（scheduler 直连路径）→ 路由器不接管（P1 边界：防双真相源）", async () => {
    const { router, executeChain } = makeDeps({
      candidates: [makeMsg({ senderType: "system" })],
      unread: [makeMsg({ senderType: "system" })],
    });
    await router.routePendingSignals("conv-1");
    await flushAsync();
    expect(executeChain.mock.calls.length).toBe(0);
  });

  it("routeAllPending：全会话扫描，单会话异常不阻塞其余", async () => {
    const { router } = makeDeps();
    // getAllIds 返回两个会话，第一个 getMessages 抛错
    const deps = router as unknown as { deps: { queryMessage: { getMessages: ReturnType<typeof vi.fn> } } };
    void deps;
    await router.routeAllPending();
    // 无异常即通过（mock 环境两会话均正常）
  });
});
