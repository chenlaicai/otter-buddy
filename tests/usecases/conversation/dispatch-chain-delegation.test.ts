import { describe, expect, it, vi } from "vitest";
import { DispatchChainEngine, type InvokeFn } from "@usecases/conversation/dispatch-chain-engine";
import { DelegationInFlightError } from "@entities/errors";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { Invoke } from "@entities/conversation/invoke";
import { createCapturingLogger } from "../../helpers/logger";

function invokeRow(id: string, otterId = "otter-1"): Invoke {
  return { id, status: "completed", otterId, talkingStonePassedTo: [], endedAt: "2026-10-27", conversationId: "conv-1", triggerEntryId: null, startedAt: "2026-10-27", toolCallCount: 0, tokenUsageInput: null, tokenUsageOutput: null, ctxWindowUsed: null, metadata: null, pid: null };
}

function makeEngine(overrides?: { isRunning?: (otterId: string) => boolean; followUp?: (otterId: string, text: string, options?: { delegated?: boolean; conversationId?: string }) => Promise<boolean> }) {
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

describe("F20261026cnsv D2 链式 hop 委托", () => {
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

  it("单飞行拒绝不被 rejected 容错吞掉，不 fallback 重投", async () => {
    const invokeFn: InvokeFn = async () => { throw new Error("拒绝后不得重投"); };
    const { engine } = makeEngine({ isRunning: () => true, followUp: async () => { throw new DelegationInFlightError(); } });
    await expect(engine.executeChain(chain(invokeFn))).rejects.toThrow("目标海獭已有排队任务在消化");
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
});
