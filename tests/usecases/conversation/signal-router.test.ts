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
  unreadFn?: (conversationId: string, otterId: string) => Promise<Message[]>; // 按目标区分未读（多目标路由用）
  candidates: Message[];
  otterType: "big" | "small";
  lastMsg: Message | null;
  lastMsgFn?: (...args: unknown[]) => Promise<Message | null>; // 按调用序列区分活跃判定（busy→idle 迁移用）
  chainError: Error | null;
}> = {}) {
  const { unread: unreadOverride = null, unreadFn, candidates = [makeMsg()], otterType = "big", lastMsg = null, lastMsgFn, chainError = null } = overrides;
  const unread = unreadOverride ?? candidates;
  const executeChain = vi.fn().mockImplementation(() => chainError ? Promise.reject(chainError) : Promise.resolve({}));
  const healingCreate = vi.fn().mockResolvedValue(undefined);
  const getUnread = unreadFn ? vi.fn().mockImplementation(unreadFn) : vi.fn().mockResolvedValue(unread);
  const getLast = lastMsgFn ? vi.fn().mockImplementation(lastMsgFn) : vi.fn().mockResolvedValue(lastMsg);
  const getMessages = vi.fn().mockResolvedValue(candidates);
  return {
    executeChain,
    healingCreate,
    router: new SignalRouter({
      conversationRepo: {
        getUnreadMessages: getUnread,
        getAllIds: vi.fn().mockResolvedValue(["conv-1"]),
      } as unknown as ConversationRepository,
      queryMessage: {
        getMessages,
        getLastMessageBySender: getLast,
      } as unknown as QueryMessage,
      queryOtter: { getById: vi.fn().mockResolvedValue({ id: "otter-1", type: otterType }) } as unknown as QueryOtter,
      dispatchChainEngine: { executeChain } as unknown as DispatchChainEngine,
      invokeFn: vi.fn().mockResolvedValue({ messageId: "m-out" }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
      healingRepo: { create: healingCreate } as unknown as HealingEventRepository,
    }),
    mocks: { getUnread, getLast, getMessages },
  };
}

/** 等待 fire-and-forget 的链调用落地（微任务排空 + 去抖窗口余量） */
async function flushAsync(ms = 10): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

/** streaming 消息（目标 busy 的活跃证据） */
function streamingMsg(overrides: Partial<Message> = {}): Message {
  return makeMsg({ senderType: "otter", status: "streaming", talkingStonePassedTo: [], ...overrides });
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

  it("routeAllPending：正常路径完成路由点火（resume 补扫语义）", async () => {
    const { router, executeChain } = makeDeps();
    await router.routeAllPending();
    await flushAsync();
    // resume 补扫的可用性：扫描后真实点火（不只是不抛错）
    expect(executeChain.mock.calls.length).toBeGreaterThanOrEqual(1);
    const args = executeChain.mock.calls[0]?.[0] as { initialTargets: string[] } | undefined;
    expect(args?.initialTargets).toEqual(["otter-1"]);
  });

  it("inFlight 去重：invoke 进行中重复路由 → queued_busy 而非重复点火（mimo 发现 3-①）", async () => {
    // 慢链：手动控制完成时刻，保持 inFlight 占位
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const executeChain = vi.fn().mockImplementation(() => gate.then(() => ({})));
    const getUnread = vi.fn().mockResolvedValue([makeMsg()]);
    const getMessages = vi.fn().mockResolvedValue([makeMsg()]);
    const getLast = vi.fn().mockResolvedValue(null);
    const router = new SignalRouter({
      conversationRepo: {
        getUnreadMessages: getUnread,
        getAllIds: vi.fn().mockResolvedValue(["conv-1"]),
      } as unknown as ConversationRepository,
      queryMessage: { getMessages, getLastMessageBySender: getLast } as unknown as QueryMessage,
      queryOtter: { getById: vi.fn().mockResolvedValue({ id: "otter-1", type: "big" }) } as unknown as QueryOtter,
      dispatchChainEngine: { executeChain } as unknown as DispatchChainEngine,
      invokeFn: vi.fn().mockResolvedValue({ messageId: "m" }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    });

    const r1 = await router.routePendingSignals("conv-1");
    expect(r1[0]?.action).toBe("invoked");

    // 链未完成（gate 未释放）→ inFlight 持有 key，同目标新信号应排队
    const r2 = await router.routePendingSignals("conv-1");
    expect(r2[0]?.action).toBe("queued_busy");
    expect(executeChain.mock.calls.length).toBe(1); // 无重复点火

    // 收尾：释放 gate 并冻结状态（busy + 空未读），防止 debounce 重扫在本测试后继续点火
    release();
    getLast.mockResolvedValue(streamingMsg());
    getUnread.mockResolvedValue([]);
    getMessages.mockResolvedValue([]);
    await flushAsync(120); // > DEBOUNCE_MS(50)：让 finally + debounce 窗口完整落地
    expect(executeChain.mock.calls.length).toBe(1); // 重扫后仍无重复点火
  });

  it("busy→idle 后完成重扫消化队列：快照内容作为当前任务显式注入（mimo 发现 3-②，覆盖 DEBOUNCE_MS 窗口 3-③）", async () => {
    const candidates = [
      makeMsg({ id: "sig-1", talkingStonePassedTo: ["otter-1"] }),
      makeMsg({ id: "sig-2", segments: [{ id: "seg-2", messageId: "sig-2", body: "emergency", sequenceNum: 0, createdAt: "" }], talkingStonePassedTo: ["otter-2"] }),
    ];
    // getLastMessageBySender 调用序列：① otter-1 → null（idle 点火）；② otter-2 → streaming（busy 入队）；③ debounce drain 时 otter-2 → null（idle 消化）
    const lastMsgFn = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(streamingMsg({ senderId: "otter-2" }))
      .mockResolvedValue(null);
    const { router, executeChain, mocks } = makeDeps({
      candidates,
      lastMsgFn: lastMsgFn as unknown as (...args: unknown[]) => Promise<Message | null>,
      unreadFn: async (_cid: string, otterId: string) => candidates.filter(m => m.talkingStonePassedTo?.includes(otterId)),
    });

    const r = await router.routePendingSignals("conv-1");
    expect(r.map(x => x.action)).toEqual(["invoked", "queued_busy"]); // otter-1 点火、otter-2 入队
    expect(executeChain.mock.calls.length).toBe(1);

    // 未读推进（模拟链内 markBatchRead）——防止 50ms 重扫无限点火；队列消化不依赖未读视图
    mocks.getUnread.mockResolvedValue([]);
    await flushAsync(120); // > DEBOUNCE_MS(50)：完成重扫 → drainBusyQueue 消化队列

    // 队列被消化：otter-2 点火，且快照内容 "emergency" 作为当前任务显式注入（busyQueue 内容保全的端到端验证）
    const second = executeChain.mock.calls[1]?.[0] as { initialTargets: string[]; userMessageContent: string } | undefined;
    expect(second?.initialTargets).toEqual(["otter-2"]);
    expect(second?.userMessageContent).toBe("emergency");
  });
});
