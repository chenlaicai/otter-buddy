import { describe, expect, it, vi } from "vitest";
import { DispatchChainEngine, type InvokeFn } from "@usecases/conversation/dispatch-chain-engine";
import { DelegationInFlightError } from "@entities/errors";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { Invoke } from "@entities/conversation/invoke";
import { createCapturingLogger } from "../../helpers/logger";

function invokeRow(id: string, otterId = "otter-1", tsp: string[] = []): Invoke {
  return { id, status: "completed", otterId, talkingStonePassedTo: tsp, endedAt: "2026-10-27", conversationId: "conv-1", triggerEntryId: null, startedAt: "2026-10-27", toolCallCount: 0, tokenUsageInput: null, tokenUsageOutput: null, ctxWindowUsed: null, metadata: null, pid: null };
}

function makeEngine(overrides?: {
  isRunning?: (otterId: string) => boolean;
  followUp?: (otterId: string, text: string, options?: { delegated?: boolean; conversationId?: string }) => Promise<boolean>;
  systemEntryRepo?: { createSystemEntry: (input: { conversationId: string; body: string }) => Promise<unknown> };
}) {
  const logger = createCapturingLogger();
  const conversationRepo = {
    getById: async () => ({ id: "conv-1", title: "并发语义" }),
    getActiveParticipants: async () => [{ otterId: "otter-1" }, { otterId: "otter-2" }],
  } as unknown as ConversationRepository;
  const queryOtter = { getById: async (id: string) => ({ id, name: id, type: "small", status: "active" }) } as unknown as QueryOtter;
  const entryRepo = { getUnreadEntries: async () => [], getEntries: async () => [], getMaxSeq: async () => 0 } as unknown as EntryRepository;
  const invokeRepo = { getInvokeById: vi.fn() } as unknown as InvokeRepository;
  return { engine: new DispatchChainEngine({ conversationRepo, queryOtter, logger, entryRepo, invokeRepo, ...overrides }), logger, invokeRepo };
}

const chain = (invokeFn: InvokeFn, targets = ["otter-1"]) => ({
  conversationId: "conv-1", userMessageContent: "任务", senderId: "user-1", initialTargets: targets, invokeFn,
});

describe("F20261027cnsv D2 链式 hop 委托", () => {
  it("running → followUp：不 invoke、不查空 invoke、不路由下一 hop", async () => {
    const invokeFn: InvokeFn = async () => { throw new Error("delegated hop 不得创建 invoke"); };
    const { engine, invokeRepo, logger } = makeEngine({ isRunning: () => true, followUp: async () => true });
    await expect(engine.executeChain(chain(invokeFn))).resolves.toEqual({ otterReply: undefined });
    expect(invokeRepo.getInvokeById).not.toHaveBeenCalled();
    expect(logger.captured.infos).toContain("发言链 hop 已投递（delegated）");
    expect(logger.captured.infos).not.toContain("发言链调用");
  });

  it("followUp false 才 fallback invoke", async () => {
    const { engine, invokeRepo, logger } = makeEngine({ isRunning: () => true, followUp: async () => false });
    vi.mocked(invokeRepo.getInvokeById).mockImplementation(async (id) => {
      if (id !== "real-invoke") throw new Error("读取了非 invoke hop");
      return invokeRow(id);
    });
    await expect(engine.executeChain(chain(async () => ({ messageId: "real-invoke" })))).resolves.toEqual({ otterReply: undefined });
    expect(logger.captured.infos).toContain("发言链调用");
    expect(logger.captured.infos).toContain("发言链 followUp 未命中，降级直接 invoke");
  });

  it("idle 直接 invoke，不排队", async () => {
    const { engine, invokeRepo, logger } = makeEngine({ isRunning: () => false, followUp: async () => true });
    vi.mocked(invokeRepo.getInvokeById).mockImplementation(async (id) => {
      if (id !== "real-invoke") throw new Error("读取了非 invoke hop");
      return invokeRow(id);
    });
    await expect(engine.executeChain(chain(async () => ({ messageId: "real-invoke" })))).resolves.toEqual({ otterReply: undefined });
    expect(logger.captured.infos).toContain("发言链调用");
    expect(logger.captured.infos).not.toContain("发言链 hop 已投递（delegated）");
  });

  it("单目标单飞行拒绝：链不 abort（rejects 不再外抛），不 fallback 重投，人话系统通知落账", async () => {
    // F20261027cnsv 审视修复（Feb 发现 1）：旧断言 executeChain rejects 把「整链 abort」钉成
    // 预期行为，与 D2「新 hop 快速失败（人话）+ 显式拒绝而非静默丢」口径冲突——
    // 修复后被拒目标走 rejected 结果通道（不重投），链正常收敛，人话通知显式告知。
    const invokeFn: InvokeFn = async () => { throw new Error("拒绝后不得重投"); };
    const systemBodies: string[] = [];
    const { engine, invokeRepo, logger } = makeEngine({
      isRunning: () => true,
      followUp: async () => { throw new DelegationInFlightError(); },
      systemEntryRepo: { createSystemEntry: async (input) => { systemBodies.push(`${input.conversationId}|${input.body}`); return {}; } },
    });
    await expect(engine.executeChain(chain(invokeFn))).resolves.toEqual({ otterReply: undefined });
    expect(invokeRepo.getInvokeById).not.toHaveBeenCalled(); // 被拒目标无产出可判
    expect(logger.captured.warns.some((w) => w.includes("单飞行拒绝"))).toBe(true); // rejected 通道日志（拒绝≠失败，warn 口径）
    expect(systemBodies).toEqual(["conv-1|目标海獭（otter-1）已有排队任务在消化，本次链式派工未投递（单委托防丢轮约束）；待当前任务结束后可重新派发。"]);
  });

  it("单飞行拒绝：通知写入失败不阻断（未注入 systemEntryRepo 降级纯日志）", async () => {
    const invokeFn: InvokeFn = async () => { throw new Error("拒绝后不得重投"); };
    const { engine } = makeEngine({
      isRunning: () => true,
      followUp: async () => { throw new DelegationInFlightError(); },
      systemEntryRepo: { createSystemEntry: async () => { throw new Error("db down"); } },
    });
    // 通知失败不影响链收敛——拒绝由 rejected 通道承载
    await expect(engine.executeChain(chain(invokeFn))).resolves.toEqual({ otterReply: undefined });
  });

  it("混合 idle+running：仅 idle 的 TSP 路由，delegated 无 hop 终态可查", async () => {
    const { engine, invokeRepo, logger } = makeEngine({ isRunning: (id) => id === "otter-2", followUp: async () => true });
    const idleInvoke: InvokeFn = async ({ otterId }) => {
      if (otterId !== "otter-1") throw new Error("running 目标不得 invoke");
      return { messageId: "idle-invoke" };
    };
    vi.mocked(invokeRepo.getInvokeById).mockImplementation(async (id) => {
      if (id !== "idle-invoke") throw new Error("不得查询空 delegated messageId");
      return invokeRow(id);
    });
    await expect(engine.executeChain(chain(idleInvoke, ["otter-1", "otter-2"]))).resolves.toEqual({ otterReply: undefined });
    expect(logger.captured.infos).toContain("发言链调用");
    expect(logger.captured.infos).toContain("发言链 hop 已投递（delegated）");
  });

  it("F20261027cnsv 审视修复（Feb 发现 1）：idle+单飞行被拒混合——兄弟目标结果不丢，正常路由下一 hop", async () => {
    // 旧实现：任一目标 DelegationInFlightError 即整批 throw，同批 idle 目标已执行的
    // invoke 结果（发言已落 entries）被整体丢弃——tsp 路由与 token 记账静默丢失，
    // 且 message-controller 误报「发言链调度失败」。
    // 修复后：被拒目标走 rejected 通道 + 人话通知；idle 兄弟照常 resolveHopOutcomes/
    // processHopResults，其 tsp 路由（→ otter-next）驱动链续跑。
    const systemBodies: string[] = [];
    const invokedTargets: string[] = [];
    const { engine, invokeRepo, logger } = makeEngine({
      isRunning: (id) => id === "otter-2", // otter-2 忙且已有 in-flight 委托
      followUp: async (id) => {
        if (id === "otter-2") throw new DelegationInFlightError();
        throw new Error(`idle 目标不应 followUp: ${id}`);
      },
      systemEntryRepo: { createSystemEntry: async (input) => { systemBodies.push(`${input.conversationId}|${input.body}`); return {}; } },
    });
    const nextHopInvoke: InvokeFn = async ({ otterId }) => {
      if (otterId !== "otter-next") throw new Error(`意外目标被 invoke: ${otterId}`);
      invokedTargets.push(otterId);
      return { messageId: "next-invoke" };
    };
    const firstHopInvoke: InvokeFn = async ({ otterId }) => {
      if (otterId !== "otter-1") throw new Error("被拒目标不得 invoke");
      invokedTargets.push(otterId);
      return { messageId: "idle-invoke" };
    };
    let hop = 0;
    const invokeFn: InvokeFn = async (params) => {
      hop++;
      return hop === 1 ? firstHopInvoke(params) : nextHopInvoke(params);
    };
    vi.mocked(invokeRepo.getInvokeById).mockImplementation(async (id) => {
      if (id === "idle-invoke") return invokeRow(id, "otter-1", ["otter-next"]);
      if (id === "next-invoke") return invokeRow(id, "otter-next", []);
      throw new Error(`意外查询: ${id}`);
    });
    await expect(engine.executeChain(chain(invokeFn, ["otter-1", "otter-2"]))).resolves.toEqual({ otterReply: undefined });
    // 被拒目标：显式拒绝（rejected 日志）+ 人话通知，无 invoke
    expect(logger.captured.warns.some((w) => w.includes("单飞行拒绝"))).toBe(true);
    expect(systemBodies).toEqual(["conv-1|目标海獭（otter-2）已有排队任务在消化，本次链式派工未投递（单委托防丢轮约束）；待当前任务结束后可重新派发。"]);
    // 兄弟目标：结果未被丢弃——产出判定与路由照常执行，链续跑到 otter-next
    // （真实 invoke 序列：hop1 仅 otter-1（otter-2 被拒不 invoke），hop2 otter-next）
    expect(invokedTargets).toEqual(["otter-1", "otter-next"]);
    expect(logger.captured.infos.filter((e) => e === "发言链调用")).toHaveLength(2);
  });
});
