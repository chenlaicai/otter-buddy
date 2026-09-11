/**
 * F20260910ctlv 彻底切换补漏：SignalRouter 数据源切换测试。
 *
 * 覆盖（test09 阻断问题回归锚——user 信号只写 entries 后路由器必须能点火）：
 * - entries 优先：triggerEntryId 命中 entry → tsp = entry.yieldTargets → invoke 点火
 * - messages 兜底：scheduler 内部系统信号（范围外仍写 messages）→ tsp = message.talkingStonePassedTo
 * - entry 查不到且 message 查不到 → 跳过（无信号）
 * - 销账：followed_up/steered 后 entry.metadata.signalMeta 写 consumed
 * - user 目标过滤：yieldTargets 含 'user' 不点火
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignalRouter } from "@usecases/conversation/signal-router";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { Logger } from "@usecases/ports/logger";
import type { Entry, EntryMetadata } from "@entities/conversation/entry";

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as unknown as Logger;
}

function createEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-u1",
    conversationId: "conv-1",
    sequenceNum: 1,
    entryType: "user",
    senderType: "user",
    senderId: "user-1",
    body: "帮我看看",
    invokeId: null,
    yieldTargets: null,
    turnId: "turn-1",
    status: "completed",
    source: "web",
    metadata: null,
    senderName: "",
    contextTokens: null,
    contextTokensMax: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(overrides?: {
  entryRepo?: Partial<EntryRepository>;
  queryMessage?: Record<string, unknown>;
}) {
  const entryUpdates: Array<{ entryId: string; metadata: EntryMetadata }> = [];
  const entryRepo = {
    getEntryById: vi.fn(async () => null),
    updateEntryMetadata: vi.fn(async (entryId: string, metadata: EntryMetadata) => {
      entryUpdates.push({ entryId, metadata });
    }),
    ...overrides?.entryRepo,
  } as unknown as EntryRepository;
  const queryMessage = {
    getMessageById: vi.fn(async () => null),
    ...overrides?.queryMessage,
  } as unknown as QueryMessage;
  const conversationRepo = {
    updateMessageSignalMeta: vi.fn(async () => {}),
  } as unknown as ConversationRepository;
  const queryOtter = {
    getById: vi.fn(async (id: string) => ({ id, status: "active" })),
  } as unknown as QueryOtter;
  const chainCalls: Array<{ initialTargets: string[]; triggerMessageId?: string }> = [];
  const dispatchChainEngine = {
    executeChain: vi.fn(async (params: { initialTargets: string[]; triggerMessageId?: string }) => {
      chainCalls.push({ initialTargets: params.initialTargets, triggerMessageId: params.triggerMessageId });
      return {};
    }),
  } as unknown as DispatchChainEngine;
  const invokeFn = vi.fn(async () => ({ messageId: "inv-mock" }));
  const logger = createLogger();
  const factory = { isRunning: () => false, followUp: () => false, steerSession: () => false };
  const router = new SignalRouter({
    conversationRepo, queryMessage, entryRepo, queryOtter, dispatchChainEngine, invokeFn, logger, factory,
  });
  return { router, entryRepo, queryMessage, chainCalls, entryUpdates, invokeFn, logger };
}

describe("SignalRouter 数据源（F20260910ctlv 彻底切换补漏）", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("user entry 信号：entries 命中 → tsp=entry.yieldTargets → 点火（test09 回归锚）", async () => {
    const entry = createEntry({ yieldTargets: ["otter-big"] });
    const { router, chainCalls } = makeDeps({ entryRepo: { getEntryById: vi.fn(async () => entry) } });

    const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("invoked");
    expect(chainCalls).toHaveLength(1);
    expect(chainCalls[0]!.initialTargets).toEqual(["otter-big"]);
    expect(chainCalls[0]!.triggerMessageId).toBe("entry-u1");
  });

  it("entries 未命中 → messages 兜底（scheduler 内部系统信号）", async () => {
    const { router, chainCalls } = makeDeps({
      queryMessage: {
        getMessageById: vi.fn(async () => ({
          id: "sys-msg-1", status: "completed", senderType: "system", senderId: "system",
          senderName: null, talkingStonePassedTo: ["otter-big"], signalMeta: null,
          segments: [{ id: "s1", messageId: "sys-msg-1", body: "定时任务触发", sequenceNum: 0, createdAt: "" }],
        })),
      },
    });

    const results = await router.routeSignals("conv-1", { triggerMessageId: "sys-msg-1" });

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("invoked");
    expect(chainCalls[0]!.initialTargets).toEqual(["otter-big"]);
  });

  it("entry 与 message 均未命中 → 无信号跳过", async () => {
    const { router, chainCalls } = makeDeps();
    const results = await router.routeSignals("conv-1", { triggerMessageId: "nonexistent" });
    expect(results).toHaveLength(0);
    expect(chainCalls).toHaveLength(0);
  });

  it("user 目标过滤：yieldTargets 只含 'user' → 不点火", async () => {
    const entry = createEntry({ yieldTargets: ["user"] });
    const { router, chainCalls } = makeDeps({ entryRepo: { getEntryById: vi.fn(async () => entry) } });

    const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

    expect(results).toHaveLength(0);
    expect(chainCalls).toHaveLength(0);
  });

  it("steered 后 entry 销账：metadata.signalMeta 写 consumed（默认 steer 口径）", async () => {
    const entry = createEntry({ yieldTargets: ["otter-big"] });
    const entryUpdates: Array<{ entryId: string; metadata: EntryMetadata }> = [];
    // 目标 running → 默认 steer 注入成功 → 销账（F20260910ctlv test13：用户发言默认 steer）
    const factory = { isRunning: () => true, followUp: () => false, steerSession: () => true };
    const routerRunning = new SignalRouter({
      conversationRepo: {} as never, queryMessage: { getMessageById: async () => null } as never,
      entryRepo: { getEntryById: async () => entry, updateEntryMetadata: async (id: string, meta: EntryMetadata) => entryUpdates.push({ entryId: id, metadata: meta }) } as never,
      queryOtter: { getById: async (id: string) => ({ id, status: "active" }) } as never,
      dispatchChainEngine: { executeChain: async () => ({}) } as never,
      invokeFn: async () => ({ messageId: "inv" }),
      logger: createLogger(), factory,
    });

    const results = await routerRunning.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

    expect(results[0]!.action).toBe("steered");
    expect(entryUpdates).toHaveLength(1);
    const meta = JSON.parse(entryUpdates[0]!.metadata.signalMeta as string) as { consumed: string };
    expect(meta.consumed).toBe("steered");
  });

  it("injectionMode=followUp（副按钮排队）→ followUp 注入 + consumed=followed_up（F20260910ctlv followUp 按钮）", async () => {
    const entry = createEntry({ yieldTargets: ["otter-big"], metadata: { injectionMode: "followUp" } });
    const entryUpdates: Array<{ entryId: string; metadata: EntryMetadata }> = [];
    const followCalls: string[] = [];
    const steerCalls: string[] = [];
    // 目标 running + 用户显式选 followUp → 排队注入（不打断）
    const factory = {
      isRunning: () => true,
      followUp: (_id: string, text: string) => { followCalls.push(text); return true; },
      steerSession: (id: string, text: string) => { steerCalls.push(`${id}:${text}`); return true; },
    };
    const routerF = new SignalRouter({
      conversationRepo: {} as never, queryMessage: { getMessageById: async () => null } as never,
      entryRepo: { getEntryById: async () => entry, updateEntryMetadata: async (id: string, meta: EntryMetadata) => entryUpdates.push({ entryId: id, metadata: meta }) } as never,
      queryOtter: { getById: async (id: string) => ({ id, status: "active" }) } as never,
      dispatchChainEngine: { executeChain: async () => ({}) } as never,
      invokeFn: async () => ({ messageId: "inv" }),
      logger: createLogger(), factory,
    });

    const results = await routerF.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

    expect(results[0]!.action).toBe("followed_up");
    expect(followCalls).toHaveLength(1);
    expect(steerCalls).toHaveLength(0); // 显式 followUp 不走 steer（不打断）
    const meta = JSON.parse(entryUpdates[0]!.metadata.signalMeta as string) as { consumed: string };
    expect(meta.consumed).toBe("followed_up");
  });

  it("目标 inactive → skipped_inactive", async () => {
    const entry = createEntry({ yieldTargets: ["otter-gone"] });
    const { router, chainCalls } = makeDeps({ entryRepo: { getEntryById: vi.fn(async () => entry) } });
    // 覆写 otter 状态
    (router as unknown as { deps: { queryOtter: { getById: ReturnType<typeof vi.fn> } } }).deps.queryOtter.getById = vi.fn(async () => ({ id: "otter-gone", status: "dissolved" }));

    const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

    expect(results[0]!.action).toBe("skipped_inactive");
    expect(chainCalls).toHaveLength(0);
  });

  it("routeDirectSignal：entry 信号直投（scheduler/招聘通道同数据源）", async () => {
    const entry = createEntry({ entryType: "system", senderType: "system", senderId: "system", yieldTargets: ["otter-big"] });
    const { router, chainCalls } = makeDeps({ entryRepo: { getEntryById: vi.fn(async () => entry) } });

    const action = await router.routeDirectSignal("conv-1", "entry-u1", "otter-big");
    expect(action).toBe("invoked");
    expect(chainCalls[0]!.initialTargets).toEqual(["otter-big"]);
  });
});
