/**
 * 彻底切换补漏：SignalRouter 数据源切换测试。
 *
 * 覆盖（test09 阻断问题回归锚——user 信号只写 entries 后路由器必须能点火）：
 * - entries 优先：triggerEntryId 命中 entry → tsp = entry.yieldTargets → invoke 点火
 * - messages 兜底：scheduler 内部系统信号（范围外仍写 messages）→ tsp = message.talkingStonePassedTo
 * - entry 查不到且 message 查不到 → 跳过（无信号）
 * - 销账：followed_up/steered 后 entry.metadata.signalMeta 写 consumed
 * - user 目标过滤：yieldTargets 含 'user' 不点火
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignalRouter, type SignalRouterSessionFactory } from "@usecases/conversation/signal-router";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
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
  factory?: Partial<SignalRouterSessionFactory>;
  conversationRepo?: Partial<ConversationRepository>;
  settingsRepo?: { get: (key: string) => Promise<string | null> };
}) {
  const entryUpdates: Array<{ entryId: string; metadata: EntryMetadata }> = [];
  const entryRepo = {
    getEntryById: vi.fn(async () => null),
    updateEntryMetadata: vi.fn(async (entryId: string, metadata: EntryMetadata) => {
      entryUpdates.push({ entryId, metadata });
    }),
    ...overrides?.entryRepo,
  } as unknown as EntryRepository;
  const conversationRepo = {
    updateMessageSignalMeta: vi.fn(async () => {}),
    ...overrides?.conversationRepo,
  } as unknown as ConversationRepository;
  const queryOtter = {
    getById: vi.fn(async (id: string) => ({ id, status: "active" })),
  } as unknown as QueryOtter;
  const chainCalls: Array<{ initialTargets: string[]; triggerMessageId?: string; externalProfile?: "restricted"; userMessageContent?: string }> = [];
  const dispatchChainEngine = {
    executeChain: vi.fn(async (params: { initialTargets: string[]; triggerMessageId?: string; externalProfile?: "restricted"; userMessageContent?: string }) => {
      chainCalls.push({
        initialTargets: params.initialTargets,
        triggerMessageId: params.triggerMessageId,
        externalProfile: params.externalProfile,
        userMessageContent: params.userMessageContent,
      });
      return {};
    }),
  } as unknown as DispatchChainEngine;
  const invokeFn = vi.fn(async () => ({ messageId: "inv-mock" }));
  const logger = createLogger();
  const factory: SignalRouterSessionFactory = {
    isRunning: () => false,
    followUp: async () => false,
    steerSession: async () => false,
    ...overrides?.factory,
  };
  const router = new SignalRouter({
    conversationRepo, entryRepo, queryOtter, dispatchChainEngine, invokeFn, logger, factory,
    ...(overrides?.settingsRepo
      ? { settingsRepo: { get: overrides.settingsRepo.get, set: async () => {} } as never }
      : {}),
  });
  return { router, entryRepo, chainCalls, entryUpdates, invokeFn, logger };
}

describe("SignalRouter 数据源（F20260913ctlv 彻底切换补漏）", () => {
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

  it("external entry 显式传递 restricted 档，且不注入普通热池", async () => {
    const entry = createEntry({
      senderId: "alice", source: "external", yieldTargets: ["otter-big"],
    });
    const steerSession = vi.fn(async () => true);
    const { router, chainCalls } = makeDeps({
      entryRepo: { getEntryById: vi.fn(async () => entry) },
      factory: { isRunning: () => true, steerSession },
    });

    const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

    expect(results[0]!.action).toBe("invoked");
    expect(chainCalls[0]!.externalProfile).toBe("restricted");
    expect(steerSession).not.toHaveBeenCalled();
  });

  describe("F20261119extsg D3：kind=external 对话的网页发言（真实入口链路）", () => {
    const convRepo = (kind: string) => ({
      getById: vi.fn(async () => ({ id: "conv-1", kind })),
    }) as unknown as Partial<ConversationRepository>;
    const externalConv = convRepo("external");
    const normalConv = convRepo("normal");
    const settingsRepo = { get: vi.fn(async () => "chen") };

    it("冷启动路径：注入正文不含搭档真名，且按受限档点火", async () => {
      const entry = createEntry({ senderId: "user", source: "web", yieldTargets: ["otter-big"], body: "网页补充" });
      const { router, chainCalls } = makeDeps({
        entryRepo: { getEntryById: vi.fn(async () => entry) },
        conversationRepo: externalConv,
        settingsRepo,
      });

      const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

      expect(results[0]!.action).toBe("invoked");
      expect(chainCalls[0]!.externalProfile).toBe("restricted");
      expect(chainCalls[0]!.userMessageContent).not.toContain("chen");
      expect(chainCalls[0]!.userMessageContent).toContain("外部用户");
      expect(chainCalls[0]!.userMessageContent).toContain("网页补充");
    });

    it("热路径（steer）：外部对话不走旁路，改走受限档点火", async () => {
      const entry = createEntry({ senderId: "user", source: "web", yieldTargets: ["otter-big"], body: "紧急性补充" });
      const steerSession = vi.fn(async () => true);
      const { router, chainCalls } = makeDeps({
        entryRepo: { getEntryById: vi.fn(async () => entry) },
        conversationRepo: externalConv,
        settingsRepo,
        factory: { isRunning: () => true, steerSession },
      });

      const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

      expect(steerSession).not.toHaveBeenCalled();
      expect(results[0]!.action).toBe("invoked");
      expect(chainCalls[0]!.userMessageContent).not.toContain("chen");
    });

    it("热路径（followUp 排队）：外部对话同样按受限档点火，注入文本中性", async () => {
      const entry = createEntry({
        senderId: "user", source: "web", yieldTargets: ["otter-big"], body: "排队补充",
        metadata: { injectionMode: "followUp" },
      });
      const followUp = vi.fn(async () => true);
      const { router, chainCalls } = makeDeps({
        entryRepo: { getEntryById: vi.fn(async () => entry) },
        conversationRepo: externalConv,
        settingsRepo,
        factory: { isRunning: () => true, followUp },
      });

      const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

      expect(followUp).not.toHaveBeenCalled();
      expect(results[0]!.action).toBe("invoked");
      expect(chainCalls[0]!.userMessageContent).not.toContain("chen");
    });

    it("普通对话不误伤：网页发言仍带显示名并保留 steer", async () => {
      const entry = createEntry({ senderId: "user", source: "web", yieldTargets: ["otter-big"], body: "常规补充" });
      const steerSession = vi.fn(async () => true);
      const { router } = makeDeps({
        entryRepo: { getEntryById: vi.fn(async () => entry) },
        conversationRepo: normalConv,
        settingsRepo,
        factory: { isRunning: () => true, steerSession },
      });

      const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

      expect(results[0]!.action).toBe("steered");
      // steerSession 首参是 targetId，注入文本是第二参
      const steerText = (steerSession.mock.calls[0] as unknown as [string, string])[1];
      expect(steerText).toContain("chen");
    });

    it("类别回读失败按外部档处理（fail-closed），不泄漏显示名", async () => {
      const entry = createEntry({ senderId: "user", source: "web", yieldTargets: ["otter-big"], body: "异常路径" });
      const { router, chainCalls } = makeDeps({
        entryRepo: { getEntryById: vi.fn(async () => entry) },
        conversationRepo: { getById: vi.fn(async () => { throw new Error("db down"); }) } as unknown as Partial<ConversationRepository>,
        settingsRepo,
      });

      await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

      expect(chainCalls[0]!.externalProfile).toBe("restricted");
      expect(chainCalls[0]!.userMessageContent).not.toContain("chen");
    });
  });

  it("system entry 信号（scheduler 内部信号，收尾批2 切 entries）：yieldTargets → 点火", async () => {
    // 收尾批2：scheduler createSystemSignalEntry 落 system entry（yieldTargets=tsp），
    // routeDirectSignal 经 loadSignalView 读 entries——messages 兜底分支已删
    const { router, chainCalls } = makeDeps({
      entryRepo: {
        getEntryById: vi.fn<(id: string) => Promise<Entry | null>>(async () => ({
          id: "sys-entry-1", conversationId: "conv-1", sequenceNum: 5, entryType: "system" as const,
          senderType: "system", senderId: "system", body: "定时任务触发",
          invokeId: null, yieldTargets: ["otter-big"], turnId: "t1", status: "completed",
          source: null, metadata: null, senderName: "system",
          contextTokens: null, contextTokensMax: null, createdAt: "", completedAt: "",
        })),
      },
    });

    const results = await router.routeSignals("conv-1", { triggerMessageId: "sys-entry-1" });

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
    // 目标 running → 默认 steer 注入成功 → 销账（test13：用户发言默认 steer）
    const factory = { isRunning: () => true, followUp: async () => false, steerSession: async () => true };
    const routerRunning = new SignalRouter({
      conversationRepo: {} as never,
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

  it("injectionMode=followUp（副按钮排队）→ followUp 注入 + consumed=followed_up（F20260913ctlv followUp 按钮）", async () => {
    const entry = createEntry({ yieldTargets: ["otter-big"], metadata: { injectionMode: "followUp" } });
    const entryUpdates: Array<{ entryId: string; metadata: EntryMetadata }> = [];
    const followCalls: string[] = [];
    const steerCalls: string[] = [];
    // 目标 running + 用户显式选 followUp → 排队注入（不打断）
    const factory = {
      isRunning: () => true,
      followUp: async (_id: string, text: string) => { followCalls.push(text); return true; },
      steerSession: async (id: string, text: string) => { steerCalls.push(`${id}:${text}`); return true; },
    };
    const routerF = new SignalRouter({
      conversationRepo: {} as never,
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

  it("stale running + durable idle：steer 未 admitted → 回退新 invoke 且不销账（#1788）", async () => {
    const entry = createEntry({ yieldTargets: ["otter-big"] });
    const { router, chainCalls, entryUpdates } = makeDeps({
      entryRepo: { getEntryById: vi.fn(async () => entry) },
      factory: { isRunning: () => true, steerSession: async () => false },
    });

    const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

    expect(results[0]!.action).toBe("invoked");
    expect(chainCalls).toHaveLength(1);
    expect(entryUpdates).toHaveLength(0);
  });

  it("显式 followUp 同族 idle 竞态：未 admitted → 回退新 invoke 且不销账（#1788）", async () => {
    const entry = createEntry({ yieldTargets: ["otter-big"], metadata: { injectionMode: "followUp" } });
    const { router, chainCalls, entryUpdates } = makeDeps({
      entryRepo: { getEntryById: vi.fn(async () => entry) },
      factory: { isRunning: () => true, followUp: async () => false },
    });

    const results = await router.routeSignals("conv-1", { triggerMessageId: "entry-u1" });

    expect(results[0]!.action).toBe("invoked");
    expect(chainCalls).toHaveLength(1);
    expect(entryUpdates).toHaveLength(0);
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
