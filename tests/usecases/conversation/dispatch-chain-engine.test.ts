import { describe, it, expect, vi } from "vitest";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import { PartnerResolver } from "@usecases/im/partner-resolver";
import type { Message } from "@entities/conversation/message";

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "m-1", conversationId: "conv-1", senderId: "otter-1",
    senderType: "otter", status: "completed",
    segments: [{ id: "seg-1", messageId: "m-1", body: "hi", sequenceNum: 0, createdAt: "" }],
    sequenceNum: 1,
    talkingStonePassedTo: [], contextTokens: null, contextTokensMax: null,
    source: "web", senderName: "Test Otter", createdAt: "", completedAt: "",
    ...overrides,
  };
}

function makeMocks() {
  const updateLastReadSeq = vi.fn();
  // F20260904schf：链引擎改读行级 tsp（getMessageById 的 talkingStonePassedTo），
  // mock 默认按 messageId 返回对应消息行（tsp 默认空）——需 yield 路由的测试自行 override mockImplementation 注册行级 tsp
  const getMessageById = vi.fn(async (messageId: string) => makeMsg({ id: messageId }));
  const getLastMessageBySender = vi.fn().mockResolvedValue(makeMsg());

  const conversationRepo = {
    getActiveParticipants: vi.fn().mockResolvedValue([]),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    getMaxTurnNumber: vi.fn().mockResolvedValue(0),
    updateLastReadSeq, getLastMessageBySender,
    getMessageById,
    getParticipant: vi.fn().mockResolvedValue(null),
  } as unknown as ConversationRepository;

  const queryOtter = { getById: vi.fn().mockResolvedValue(null) } as unknown as QueryOtter;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  // F20260913ctlv 彻底切换：未读注入读 entries——mock entryRepo（entry 形状）
  const entryRepo = {
    getUnreadEntries: vi.fn().mockResolvedValue([]),
    getEntries: vi.fn().mockResolvedValue([]),
  } as unknown as EntryRepository;
  const getInvokeById = vi.fn(async (id: string) => ({ id, status: 'completed' as const, otterId: 'otter-x', talkingStonePassedTo: [] as string[], endedAt: '2026-09-10T00:00:00Z' }));
  const invokeRepo = {
    getInvokeById,
  } as unknown as InvokeRepository;

  return { conversationRepo, queryOtter, logger, entryRepo, invokeRepo, getInvokeById, updateLastReadSeq, getMessageById, getLastMessageBySender };
}

describe("executeChain nextTargets 路由（#474: 熔断重启后 yield 交棒失效）", () => {
  /** 复现 8-26 现场：scheduler 路径 senderId=大獭（任务属主），小獭 yield 回属主被旧 filter 吞掉 */
  function makeChainMocks() {
    const m = makeMocks();
    const invoked: string[] = [];
    return {
      m,
      invoked,
      /** invokeFn：目标 yield 回 owner-otter（模拟小獭交付后交棒） */
      invokeFn: async ({ otterId }: { otterId: string }) => {
        invoked.push(otterId);
        if (otterId === "otter-worker") return { messageId: "m-work", aggregatedTargets: ["owner-otter"] };
        return { messageId: "m-owner" };
      },
    };
  }

  it("scheduler 路径：小獭 yield 回任务属主 otter，属主应被唤醒（不再被 senderId 过滤吞掉）", async () => {
    const { m, invoked, invokeFn } = makeChainMocks();
    // F20260913ctlv 彻底切换：行级出处 = invoke 行 tsp（生产中 yield 工具落 invokes.talkingStonePassedTo）
    (m.getInvokeById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === "m-work"
        ? { id, status: "completed", otterId: "otter-worker", talkingStonePassedTo: ["owner-otter"], endedAt: "2026-09-10T00:00:00Z" }
        : { id, status: "completed", otterId: "owner-otter", talkingStonePassedTo: [], endedAt: "2026-09-10T00:00:00Z" });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "owner-otter",
      initialTargets: ["otter-worker"],
      invokeFn,
    });

    /** 链应续跳：小獭 → 属主两跳都被 invoke */
    expect(invoked).toEqual(["otter-worker", "owner-otter"]);
  });

  it("web 路径：senderId=user 时 yield to user 仍被滤除（人类不参与链调度）", async () => {
    const { m, invoked } = makeChainMocks();
    (m.getInvokeById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === "m-work"
        ? { id, status: "completed", otterId: "otter-worker", talkingStonePassedTo: ["user"], endedAt: "2026-09-10T00:00:00Z" }
        : { id, status: "completed", otterId: "owner-otter", talkingStonePassedTo: [], endedAt: "2026-09-10T00:00:00Z" });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      invokeFn: async ({ otterId }: { otterId: string }) => {
        invoked.push(otterId);
        return { messageId: "m-work", aggregatedTargets: ["user"] };
      },
    });

    expect(invoked).toEqual(["otter-worker"]);
  });

  it("F20260907ylfs ②：yield 回自己 = 任务锚点入箱，护栏放行链续跑（无消息表服务时降级 0 永放行，maxChainDepth 兜底）", async () => {
    const { m } = makeChainMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, maxChainDepth: 10, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });
    const invoked: string[] = [];

    // F20260913ctlv 彻底切换：self-yield 出处 = invoke 行 tsp（yield 回自己）
    (m.getInvokeById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === "m-work"
        ? { id, status: "completed", otterId: "otter-worker", talkingStonePassedTo: ["otter-worker"], endedAt: "2026-09-10T00:00:00Z" }
        : { id, status: "completed", otterId: "owner-otter", talkingStonePassedTo: [], endedAt: "2026-09-10T00:00:00Z" });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "owner-otter",
      initialTargets: ["otter-worker"],
      /** 小獭持续 yield 回自己：② 合法化后 = 任务锚点入箱，每轮重跑自己（消化），
       *  护栏（计数）才是终链手段——本测试无消息表服务（makeChainMocks 无 getMessages mock），
       *  计数降级 0 永放行，由 maxChainDepth 兜底（真实 5 跳链停见 self-yield-guardrail 集成测试） */
      invokeFn: async ({ otterId }: { otterId: string }) => {
        invoked.push(otterId);
        return { messageId: "m-work" };
      },
    });

    /** 新契约：self 不再被滤除——链持续续跑到 maxChainDepth（10 跳全为 otter-worker），
     *  旧 F20260904schf「自指滤除 → 一轮终止」不变量随 ② 合法化退役 */
    expect(invoked).toEqual(Array(10).fill("otter-worker"));
  });
});

describe("buildIdleOttersWarning（F20260920trrt 新口径：发言 seq 差 + 时间护栏 + big 限定）", () => {
  /** 新口径测试桩：读时聚合三查询。默认 maxSeq=100，无 speak、无 invoke。 */
  function makeStats(opts: {
    maxSeq?: number;
    lastSpeak?: Map<string, { seq: number; createdAt: string }>;
    lastInvoke?: Map<string, string>;
  } = {}) {
    return {
      getMaxEntrySeq: vi.fn().mockResolvedValue(opts.maxSeq ?? 100),
      getLastSpeakBySender: vi.fn().mockResolvedValue(opts.lastSpeak ?? new Map()),
      getLastInvokeStartedAtByOtter: vi.fn().mockResolvedValue(opts.lastInvoke ?? new Map()),
    };
  }
  function makeParticipant(overrides: Record<string, unknown> = {}) {
    return {
      otterId: "otter-1",
      status: "active",
      lastActiveTurnNumber: 0,
      lastReadTurnNumber: 0,
      ...overrides,
    };
  }
  /** otter 预取 mock：receiver 是 big（传 receiverId），其余是 small；传 "__no_big__" 时全员 small */
  function mockOtters(m: ReturnType<typeof makeMocks>, receiverId = "otter-current") {
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === receiverId) return { name: "大獭", type: "big" };
      return { name: `小獭-${id}`, type: "small" };
    });
  }

  it("小獭超阈值时返回预警文本（含 seq 差与最近活动）", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x" }),
      makeParticipant({ otterId: "otter-current" }),
    ]);
    mockOtters(m);
    const stats = makeStats({ maxSeq: 100, lastSpeak: new Map([["otter-x", { seq: 10, createdAt: "" }]]) });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toContain("小獭-otter-x");
    expect(result).toContain("90 条消息"); // 100 - 10
    expect(result).toContain("从未被唤醒");
    expect(result).toContain("系统提示");
  });

  it("receiver 非 big 时返回 null（小獭不再收到解散提示——乌龙修复）", async () => {
    const m = makeMocks();
    // receiver 是 small，另一个也是 small——全员无 big，预警在 receiver 过滤处即短路
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "小獭甲", type: "small" });
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x" }),
      makeParticipant({ otterId: "otter-also-small" }),
    ]);
    const stats = makeStats({ maxSeq: 100, lastSpeak: new Map([["otter-x", { seq: 0, createdAt: "" }]]) });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-also-small");
    expect(result).toBeNull();
  });

  it("时间护栏：seq 差超阈值但 2h 内被唤醒过 → 不告警", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x" }),
      makeParticipant({ otterId: "otter-current" }),
    ]);
    mockOtters(m);
    const stats = makeStats({
      maxSeq: 100,
      lastSpeak: new Map([["otter-x", { seq: 10, createdAt: "" }]]),
      lastInvoke: new Map([["otter-x", new Date(Date.now() - 30 * 60_000).toISOString()]]), // 30 分钟前
    });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toBeNull();
  });

  it("时间护栏：3h 前被唤醒 → 正常告警（护栏只拦 2h 内）", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x" }),
      makeParticipant({ otterId: "otter-current" }),
    ]);
    mockOtters(m);
    const lastInvokeIso = new Date(Date.now() - 3 * 3600_000).toISOString();
    const stats = makeStats({
      maxSeq: 100,
      lastSpeak: new Map([["otter-x", { seq: 10, createdAt: "" }]]),
      lastInvoke: new Map([["otter-x", lastInvokeIso]]),
    });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toContain("小獭-otter-x");
    expect(result).toContain(lastInvokeIso);
  });

  it("大獭不作为告警对象（只告小獭）", async () => {
    const m = makeMocks();
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      return { name: id === "otter-current" ? "大獭" : "另一个大獭", type: "big" };
    });
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-other-big" }),
      makeParticipant({ otterId: "otter-current" }),
    ]);
    const stats = makeStats({ maxSeq: 100 });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toBeNull();
  });

  it("从 settingsRepo 读取自定义阈值（otter_idle_threshold 语义换为 seq 差）", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x" }),
      makeParticipant({ otterId: "otter-current" }),
    ]);
    mockOtters(m);
    const settingsRepo = { get: vi.fn().mockResolvedValue("95") }; // 差值 90 < 95 → 不告警
    const stats = makeStats({ maxSeq: 100, lastSpeak: new Map([["otter-x", { seq: 10, createdAt: "" }]]) });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, settingsRepo: settingsRepo as never, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toBeNull();
  });

  it("无效阈值配置 fallback 到默认值 30", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x" }),
      makeParticipant({ otterId: "otter-current" }),
    ]);
    mockOtters(m);
    const settingsRepo = { get: vi.fn().mockResolvedValue("abc") };
    const stats = makeStats({ maxSeq: 100, lastSpeak: new Map([["otter-x", { seq: 60, createdAt: "" }]]) }); // 差值 40 > 30 → 告警
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, settingsRepo: settingsRepo as never, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toContain("40 条消息");
  });

  it("idleStatsRepo 未注入时降级返回 null（旧装配/测试桩兼容）", async () => {
    const m = makeMocks();
    mockOtters(m);
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toBeNull();
  });

  it("maxSeq 为 0 时返回 null（对话无 entry 异常边界）", async () => {
    const m = makeMocks();
    mockOtters(m);
    const stats = makeStats({ maxSeq: 0 });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toBeNull();
  });

  it("检视发现 9 回归：新入场未被唤醒的小獭在入场 2h 内不告警", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      { otterId: "otter-fresh", status: "active", createdAt: new Date(Date.now() - 30 * 60_000).toISOString() }, // 30 分钟前入场
      makeParticipant({ otterId: "otter-current" }),
    ]);
    mockOtters(m);
    const stats = makeStats({ maxSeq: 100, lastSpeak: new Map(), lastInvoke: new Map() }); // 从未发言从未被唤醒
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toBeNull(); // 入场时间参与护栏——2h 内不告警
  });

  it("检视发现 9 回归：入场超 2h 仍未被唤醒也未发言 → 正常告警（真闲置）", async () => {
    const m = makeMocks();
    const oldJoin = new Date(Date.now() - 3 * 3600_000).toISOString();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      { otterId: "otter-stale", status: "active", createdAt: oldJoin },
      makeParticipant({ otterId: "otter-current" }),
    ]);
    mockOtters(m);
    const stats = makeStats({ maxSeq: 100, lastSpeak: new Map(), lastInvoke: new Map() });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toContain("otter-stale");
    expect(result).toContain(oldJoin);
  });

  it("未发言过的小獭按 seq=0 计差（不误伤刚入场，但长期未发言会告警）", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-fresh" }),
      makeParticipant({ otterId: "otter-current" }),
    ]);
    mockOtters(m);
    const stats = makeStats({ maxSeq: 100, lastSpeak: new Map() }); // 从未发言
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toContain("100 条消息");
  });
});

describe("buildMessageWithContext 闲置预警集成", () => {
  it("无未读消息时仍注入闲置预警（早返回路径，F20260920trrt 新口径）", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      { otterId: "otter-x", status: "active", lastActiveTurnNumber: 1, lastReadTurnNumber: 0 },
      { otterId: "otter-current", status: "active", lastActiveTurnNumber: 1, lastReadTurnNumber: 0 },
    ]);
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "otter-current") return { name: "大獭", type: "big" };
      return { name: "闲置獭", type: "small" };
    });
    // 无未读消息
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const stats = {
      getMaxEntrySeq: vi.fn().mockResolvedValue(100),
      getLastSpeakBySender: vi.fn().mockResolvedValue(new Map([["otter-x", { seq: 10, createdAt: "" }]])),
      getLastInvokeStartedAtByOtter: vi.fn().mockResolvedValue(new Map()),
    };

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo, idleStatsRepo: stats });
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-current", "hi", "user-1", "## 在场成员\n- user'");

    expect(result).toContain("闲置獭");
    expect(result).toContain("90 条消息");
    expect(result).toContain("## 当前任务");
  });

  it("F20260829cach: 两条路径都注入分钟级当前时间（补偿 system prompt 日粒度锚点）", async () => {
    const m = makeMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });

    // 路径 1：无未读消息（早返回）
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const noUnread = await engine.buildMessageWithContext("conv-1", "user-1", "hi", "user-1", "## 在场成员");
    expect(noUnread.message).toMatch(/## 当前时间\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2}（Asia\/Shanghai）/);
    expect(noUnread.message.indexOf("## 当前时间")).toBeGreaterThan(noUnread.message.indexOf("## 在场成员"));
    expect(noUnread.message.indexOf("## 当前任务")).toBeGreaterThan(noUnread.message.indexOf("## 当前时间"));

    // 路径 2：有未读消息
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-otter-otter-1", entryType: "otter", senderType: "otter", senderId: "otter-1", senderName: "Test Otter", body: "msg", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);
    const withUnread = await engine.buildMessageWithContext("conv-1", "user-1", "hi", "user-1", "## 在场成员");
    expect(withUnread.message).toMatch(/## 当前时间\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2}（Asia\/Shanghai）/);
    expect(withUnread.message.indexOf("## 当前任务")).toBeGreaterThan(withUnread.message.indexOf("## 当前时间"));
  });

  it("buildIdleOttersWarning 抛异常时不影响主流程", async () => {
    const m = makeMocks();
    // getMaxTurnNumber 抛异常触发 buildIdleOttersWarning 的 try-catch
    (m.conversationRepo as unknown as { getMaxTurnNumber: ReturnType<typeof vi.fn> }).getMaxTurnNumber.mockRejectedValue(new Error("db error"));
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-otter-otter-1", entryType: "otter", senderType: "otter", senderId: "otter-1", senderName: "Test Otter", body: "msg", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });
    const { message: result } = await engine.buildMessageWithContext("conv-1", "user-1", "hi", "user-1", "## 在场成员");

    // 预警失败不影响主流程，结果仍包含对话历史和当前任务
    expect(result).toContain("## 对话历史");
    expect(result).toContain("## 当前任务");
    expect(result).not.toContain("系统提示");
  });
});

describe("buildMessageWithContext user 姓名快照（F20260826fuid: 飞书群聊多人识别）", () => {
  it("user 消息带 senderName 快照时用快照名渲染", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-ou_zhangsan", entryType: "user", senderType: "user", senderId: "ou_zhangsan", senderName: "张三", body: "我是张三的消息", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[张三] 我是张三的消息");
  });

  it("多条 user 消息不同快照名可区分", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-ou_zhangsan", entryType: "user", senderType: "user", senderId: "ou_zhangsan", senderName: "张三", body: "第一条", sequenceNum: 1, invokeId: null, yieldTargets: null },
      { id: "e-user-ou_lisi", entryType: "user", senderType: "user", senderId: "ou_lisi", senderName: "李四", body: "第二条", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[张三] 第一条");
    expect(result).toContain("[李四] 第二条");
  });

  it("当前 sender 无快照时回退「搭档」标签", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-ou_lisi", entryType: "user", senderType: "user", senderId: "ou_lisi", senderName: "", body: "在吗", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[搭档] 在吗");
  });

  it("其他 user 发言者无快照时保留裸 open_id（不冒充搭档）", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-ou_zhangsan", entryType: "user", senderType: "user", senderId: "ou_zhangsan", senderName: "", body: "我是谁", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[ou_zhangsan] 我是谁");
    expect(result).not.toContain("[搭档] 我是谁");
  });

  it("快照名仅空白时视为无快照", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-ou_lisi", entryType: "user", senderType: "user", senderId: "ou_lisi", senderName: "   ", body: "在吗", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[搭档] 在吗");
  });
});

describe("buildMessageWithContext 搭档静态绑定（F20260826fpbd）", () => {
  function makeEngine(m: ReturnType<typeof makeMocks>, partnerOpenId: string | undefined) {
    return new DispatchChainEngine({
      conversationRepo: m.conversationRepo,
            queryOtter: m.queryOtter,
      logger: m.logger,
      partnerResolver: new PartnerResolver(partnerOpenId),
      entryRepo: m.entryRepo,
      invokeRepo: m.invokeRepo,
    });
  }

  it("静态模式：配置的搭档 open_id → partnerLabel，即使非本次 sender", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-ou_chen", entryType: "user", senderType: "user", senderId: "ou_chen", senderName: "", body: "看看这个", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    // joy 触发本次派发，但历史里 chen 的消息仍标搭档（静态锚定，不随说话者变）
    const engine = makeEngine(m, "ou_chen");
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_joy", "## 在场成员");

    expect(result).toContain("[搭档] 看看这个");
  });

  it("静态模式：访客触发本次派发也无 partnerLabel（动态推断旧病修复）", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-ou_joy", entryType: "user", senderType: "user", senderId: "ou_joy", senderName: "", body: "我也觉得行", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = makeEngine(m, "ou_chen");
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_joy", "## 在场成员");

    expect(result).toContain("[ou_joy] 我也觉得行");
    expect(result).not.toContain("[搭档] 我也觉得行");
  });

  it("静态模式：访客有快照名时显示真名", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-ou_joy", entryType: "user", senderType: "user", senderId: "ou_joy", senderName: "Joy", body: "哈哈", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = makeEngine(m, "ou_chen");
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_joy", "## 在场成员");

    expect(result).toContain("[Joy] 哈哈");
  });

  it("静态模式：Web 'user' 恒为搭档", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-user", entryType: "user", senderType: "user", senderId: "user", senderName: "", body: "Web 来的", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = makeEngine(m, "ou_chen");
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "user", "## 在场成员");

    expect(result).toContain("[搭档] Web 来的");
  });

  it("降级（未配置）：维持 #488 行为——当前 sender 无快照仍标搭档", async () => {
    const m = makeMocks();
    (m.entryRepo.getUnreadEntries as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "e-user-ou_joy", entryType: "user", senderType: "user", senderId: "ou_joy", senderName: "", body: "在吗", sequenceNum: 1, invokeId: null, yieldTargets: null },
    ]);

    const engine = makeEngine(m, undefined);
    const { message: result } = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_joy", "## 在场成员");

    expect(result).toContain("[搭档] 在吗");
  });

  it("buildRoster：静态模式下访客触发时追加「当前说话者非搭档」提示", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      { otterId: "otter-1", status: "active", lastActiveTurnNumber: 1, lastReadTurnNumber: 0 },
    ]);
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "大獭" });

    const engine = makeEngine(m, "ou_chen");
    const roster = await engine.buildRoster("conv-1", "ou_joy");

    expect(roster).toContain("非你的搭档");
    expect(roster).toContain("ou_joy");
  });

  it("buildRoster：搭档触发时不追加访客提示；降级模式下也不追加", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      { otterId: "otter-1", status: "active", lastActiveTurnNumber: 1, lastReadTurnNumber: 0 },
    ]);
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "大獭" });

    const engine = makeEngine(m, "ou_chen");
    const partnerRoster = await engine.buildRoster("conv-1", "ou_chen");
    expect(partnerRoster).not.toContain("非你的搭档");

    const degraded = makeEngine(m, undefined);
    const degradedRoster = await degraded.buildRoster("conv-1", "ou_joy");
    expect(degradedRoster).not.toContain("非你的搭档");
  });
});

describe("L2 安全词扫描接线（F20260826mwrd C3 Part 6）", () => {
  /** executeChain 集成：用户消息命中「停下」→ invokeFn 收到的消息带 reminder 后缀 */
  async function runChain(userMessage: string) {
    const m = makeMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryOtter: m.queryOtter, logger: m.logger, entryRepo: m.entryRepo, invokeRepo: m.invokeRepo });
    const received: string[] = [];
    await engine.executeChain({
      conversationId: "conv-1",
      userMessageContent: userMessage,
      senderId: "user-1",
      initialTargets: ["otter-1"],
      invokeFn: async (params) => {
        received.push(params.userMessageContent);
        return { messageId: "m-x" };
      },
    });
    return received;
  }

  it("用户消息「停下」独立成词：每个 hop 的消息末尾注入 L2 reminder", async () => {
    const received = await runChain("停下");
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("[L2 安全词检测]");
    expect(received[0]).toContain("Magic Words");
    expect(received[0]).toContain("## 当前任务\n停下"); // 原文保留
  });

  it("命令形态「快停下，都别乱动」也注入 reminder", async () => {
    const received = await runChain("快停下，都别乱动");
    expect(received[0]).toContain("[L2 安全词检测]");
  });

  it("讨论语境「停下手头工作再复盘」不注入（漏报方向安全，退化 L1）", async () => {
    const received = await runChain("停下手头工作再复盘");
    expect(received[0]).not.toContain("[L2 安全词检测]");
  });

  it("普通消息零注入（不污染上下文）", async () => {
    const received = await runChain("帮我看下今天的行情");
    expect(received[0]).not.toContain("[L2 安全词检测]");
  });
});

