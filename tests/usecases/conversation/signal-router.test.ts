/**
 * SignalRouter 测试（F20260902sgp2 S2 重写：pending 真相源 = 派发台账）。
 *
 * v1（sgpv P1）判据「游标视图」已退役——本文件全部用例按 v2 语义重写：
 * pending := 已投递 ∧ 无 (message,target) attempt 记录。
 * 档位矩阵（routeTarget）/ busyQueue / inFlight 去重 / healing 语义保持不变，
 * 相关用例的判据层从 unread mock 换成台账 mock，断言面保留。
 */
import { describe, it, expect, vi } from "vitest";
import { SignalRouter } from "@usecases/conversation/signal-router";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";
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

interface PendingRow { messageId: string; targetOtterId: string; signalLevel?: string | null }

function makeDeps(overrides: Partial<{
  pending: PendingRow[];               // 台账视角的 pending (message,target) 对
  messageById: Message | null;         // getMessageById 返回（台账行只有 ID）
  otterType: "big" | "small";
  lastMsg: Message | null;
  lastMsgFn?: (...args: unknown[]) => Promise<Message | null>;
  chainError: Error | null;
}> = {}) {
  const { pending = [{ messageId: "sig-1", targetOtterId: "otter-1" }], messageById = makeMsg(), otterType = "big", lastMsg = null, lastMsgFn, chainError = null } = overrides;
  const executeChain = vi.fn().mockImplementation(() => chainError ? Promise.reject(chainError) : Promise.resolve({}));
  const healingCreate = vi.fn().mockResolvedValue(undefined);
  const getLast = lastMsgFn ? vi.fn().mockImplementation(lastMsgFn) : vi.fn().mockResolvedValue(lastMsg);
  const getMessageById = vi.fn().mockResolvedValue(messageById);
  const listPending = vi.fn().mockResolvedValue(pending);
  return {
    executeChain,
    healingCreate,
    listPending,
    getMessageById,
    router: new SignalRouter({
      conversationRepo: {
        getAllIds: vi.fn().mockResolvedValue(["conv-1"]),
      } as unknown as ConversationRepository,
      queryMessage: {
        getMessageById,
        getLastMessageBySender: getLast,
      } as unknown as QueryMessage,
      queryOtter: { getById: vi.fn().mockResolvedValue({ id: "otter-1", type: otterType, status: "active" }) } as unknown as QueryOtter,
      dispatchChainEngine: { executeChain } as unknown as DispatchChainEngine,
      invokeFn: vi.fn().mockResolvedValue({ messageId: "m-out" }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
      healingRepo: { create: healingCreate } as unknown as HealingEventRepository,
      dispatchAttemptRepo: { listPendingSignals: listPending } as unknown as DispatchAttemptRepo,
    }),
    mocks: { getLast, getMessageById, listPending },
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

describe("SignalRouter（F20260902sgp2 S2：pending = 台账真相源）", () => {
  it("台账 pending → 点火链引擎（目标 = 台账行的 targetOtterId）", async () => {
    const deps = makeDeps();
    const results = await deps.router.routePendingSignals("conv-1");
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("invoked");
    await flushAsync();
    const calls = (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: { mock: { calls: unknown[] } } } } }).deps.dispatchChainEngine.executeChain.mock.calls;
    expect(calls).toHaveLength(1);
    const target = (calls[0] as Array<{ initialTargets: string[] }>)[0].initialTargets;
    expect(target).toEqual(["otter-1"]);
  });

  it("台账空（全部已销账）→ 不点火（幂等：台账即消费账本）", async () => {
    const deps = makeDeps({ pending: [] });
    const results = await deps.router.routePendingSignals("conv-1");
    expect(results).toHaveLength(0);
    const calls = (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: { mock: { calls: unknown[] } } } } }).deps.dispatchChainEngine.executeChain.mock.calls;
    expect(calls).toHaveLength(0);
  });

  it("台账行指向的消息不存在（脏数据）→ 跳过并留 warn，不点火", async () => {
    const deps = makeDeps({ messageById: null });
    const results = await deps.router.routePendingSignals("conv-1");
    expect(results).toHaveLength(0);
    const calls = (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: { mock: { calls: unknown[] } } } } }).deps.dispatchChainEngine.executeChain.mock.calls;
    expect(calls).toHaveLength(0);
  });

  it("目标 busy（外部 streaming 消息）→ 入 busyQueue 不点火", async () => {
    const deps = makeDeps({ lastMsg: streamingMsg() });
    const results = await deps.router.routePendingSignals("conv-1");
    expect(results[0].action).toBe("queued_busy");
    const calls = (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: { mock: { calls: unknown[] } } } } }).deps.dispatchChainEngine.executeChain.mock.calls;
    expect(calls).toHaveLength(0);
  });

  it("HALT 投往小獭 → 丢弃 + healing 留痕（C2 权限拦截的绕过防线）", async () => {
    const deps = makeDeps({
      otterType: "small",
      messageById: makeMsg({ signalLevel: "HALT" }),
    });
    const results = await deps.router.routePendingSignals("conv-1");
    expect(results[0].action).toBe("skipped_no_target");
    await flushAsync();
    const healing = (deps.router as unknown as { deps: { healingRepo: { create: { mock: { calls: unknown[] } } } } }).deps.healingRepo.create.mock.calls;
    expect(healing).toHaveLength(1);
    const calls = (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: { mock: { calls: unknown[] } } } } }).deps.dispatchChainEngine.executeChain.mock.calls;
    expect(calls).toHaveLength(0);
  });

  it("链抛错 → healing 留痕（消费失败可见性，七刀之七）", async () => {
    const deps = makeDeps({ chainError: new Error("boom") });
    await deps.router.routePendingSignals("conv-1");
    await flushAsync();
    const healing = (deps.router as unknown as { deps: { healingRepo: { create: { mock: { calls: unknown[] } } } } }).deps.healingRepo.create.mock.calls;
    expect(healing).toHaveLength(1);
  });

  it("目标已解散（queryOtter 空）→ skipped_inactive，不点火", async () => {
    const deps = makeDeps();
    (deps.router as unknown as { deps: { queryOtter: { getById: ReturnType<typeof vi.fn> } } }).deps.queryOtter.getById = vi.fn().mockResolvedValue(null);
    const results = await deps.router.routePendingSignals("conv-1");
    expect(results[0].action).toBe("skipped_inactive");
  });

  it("F20260903damp：目标 status=dissolved（getById 仍返回行）→ skipped_inactive，不点火（09-03 事故回归）", async () => {
    const deps = makeDeps();
    // 复刻事故形态：getById 不过滤 status，返回 dissolved 行——路由器守卫必须拦截
    (deps.router as unknown as { deps: { queryOtter: { getById: ReturnType<typeof vi.fn> } } }).deps.queryOtter.getById = vi.fn().mockResolvedValue({ id: "otter-1", type: "small", status: "dissolved" });
    const results = await deps.router.routePendingSignals("conv-1");
    expect(results[0].action).toBe("skipped_inactive");
    await flushAsync();
    const calls = (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: { mock: { calls: unknown[] } } } } }).deps.dispatchChainEngine.executeChain.mock.calls;
    expect(calls).toHaveLength(0);
  });

  it("filter.otterId 只路由该目标的 pending 行", async () => {
    const deps = makeDeps({
      pending: [
        { messageId: "sig-1", targetOtterId: "otter-1" },
        { messageId: "sig-1", targetOtterId: "otter-2" },
      ],
    });
    const results = await deps.router.routePendingSignals("conv-1", { otterId: "otter-2" });
    expect(results).toHaveLength(1);
    expect(results[0].signal.id).toBe("sig-1");
    await flushAsync();
    const calls = (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: { mock: { calls: unknown[] } } } } }).deps.dispatchChainEngine.executeChain.mock.calls;
    expect(calls).toHaveLength(1);
  });

  it("routeAllPending：全会话扫描，单会话异常不阻塞其余", async () => {
    const deps = makeDeps();
    (deps.router as unknown as { deps: { conversationRepo: { getAllIds: ReturnType<typeof vi.fn> } } }).deps.conversationRepo.getAllIds = vi.fn().mockResolvedValue(["conv-a", "conv-b"]);
    // conv-a 的台账查询抛错，conv-b 正常
    (deps.router as unknown as { deps: { dispatchAttemptRepo: { listPendingSignals: ReturnType<typeof vi.fn> } } }).deps.dispatchAttemptRepo.listPendingSignals = vi.fn()
      .mockRejectedValueOnce(new Error("db busy"))
      .mockResolvedValueOnce([]);
    await expect(deps.router.routeAllPending()).resolves.toBeUndefined();
  });

  it("routeAllPending：正常路径完成路由点火（resume 补扫语义）", async () => {
    const deps = makeDeps();
    await deps.router.routeAllPending();
    await flushAsync();
    expect(deps.executeChain).toHaveBeenCalled();
  });

  it("inFlight 去重：invoke 进行中重复路由 → queued_busy 而非重复点火", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const deps = makeDeps();
    // 第一路由点火后 inFlight 持有；链 promise 由 gate 卡住模拟慢链
    (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: ReturnType<typeof vi.fn> } } }).deps.dispatchChainEngine.executeChain = vi.fn().mockImplementation(() => gate.then(() => ({})));
    const first = await deps.router.routePendingSignals("conv-1");
    expect(first[0].action).toBe("invoked");
    const second = await deps.router.routePendingSignals("conv-1");
    expect(second[0].action).toBe("queued_busy");
    release();
    await flushAsync();
  });

  it("busy→idle 后完成重扫消化队列：快照内容作为当前任务显式注入", async () => {
    // 序列：首轮 getLast 返回 streaming（busy 入队）；重扫时返回 null（idle）
    let callCount = 0;
    const deps = makeDeps({
      lastMsgFn: async () => {
        callCount++;
        return callCount === 1 ? streamingMsg() : null;
      },
    });
    const first = await deps.router.routePendingSignals("conv-1"); // 入队
    expect(first[0].action).toBe("queued_busy");
    expect(deps.executeChain).not.toHaveBeenCalled();
    // 模拟下一条信号触发（busyQueue 的消化靠后续触发源：新信号 / invoke 完成重扫）
    // 此时 lastMsgFn 第二次调用返回 null（idle）→ routeTarget 直接点火，但队首先消化
    // （drainBusyQueue 在 invoke 完成的 debounce 重扫里执行——这里直接驱动 drain 路径：
    // 第二次 routePendingSignals 时目标已 idle，走 invokeTarget 正常点火；
    // 队列快照内容注入由 drain 路径覆盖——直接调私有方法验证语义）
    await (deps.router as unknown as { drainBusyQueue: (c: string) => Promise<void> }).drainBusyQueue("conv-1");
    const calls = (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: { mock: { calls: unknown[] } } } } }).deps.dispatchChainEngine.executeChain.mock.calls;
    expect(calls).toHaveLength(1);
    const engineDeps = (deps.router as unknown as { deps: { dispatchChainEngine: { executeChain: ReturnType<typeof vi.fn> } } }).deps.dispatchChainEngine;
    const call = engineDeps.executeChain.mock.calls[0][0] as { userMessageContent: string };
    expect(call.userMessageContent).toBe("do it"); // 快照内容显式注入（非空串直连）
  });
});
