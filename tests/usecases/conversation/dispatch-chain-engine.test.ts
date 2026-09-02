import { describe, it, expect, vi } from "vitest";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { SendMessage } from "@usecases/conversation/send-message";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import { PartnerResolver } from "@usecases/im/partner-resolver";
import type { Turn } from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return { id: "turn-1", conversationId: "conv-1", turnNumber: 5, status: "closed", createdAt: "", closedAt: null, ...overrides };
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "m-1", conversationId: "conv-1", turnId: "turn-1", senderId: "otter-1",
    senderType: "otter", status: "completed",
    segments: [{ id: "seg-1", messageId: "m-1", body: "hi", sequenceNum: 0, createdAt: "" }],
    sequenceNum: 1,
    talkingStonePassedTo: [], contextTokens: null, contextTokensMax: null,
    source: "web", senderName: "Test Otter", createdAt: "", completedAt: "",
    ...overrides,
  };
}

function makeMocks() {
  const updateLastReadTurnNumber = vi.fn().mockResolvedValue(undefined);
  const updateLastActiveTurnNumber = vi.fn().mockResolvedValue(undefined);
  const getTurnById = vi.fn().mockResolvedValue(makeTurn());
  const getMessageById = vi.fn().mockResolvedValue(makeMsg());
  const getLastMessageBySender = vi.fn().mockResolvedValue(makeMsg());
  const getActiveTurn = vi.fn().mockResolvedValue(null);

  const conversationRepo = {
    getActiveParticipants: vi.fn().mockResolvedValue([]),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    getMaxTurnNumber: vi.fn().mockResolvedValue(0),
    getTurnById, updateLastReadTurnNumber, updateLastActiveTurnNumber, getLastMessageBySender,
    getActiveTurn, getMessageById,
    getParticipant: vi.fn().mockResolvedValue(null),
  } as unknown as ConversationRepository;

  const sendMessage = {} as unknown as SendMessage;
  const queryMessage = { getMessageById, getLastMessageBySender } as unknown as QueryMessage;
  const queryOtter = { getById: vi.fn().mockResolvedValue(null) } as unknown as QueryOtter;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  return { sendMessage, conversationRepo, queryMessage, queryOtter, logger, updateLastReadTurnNumber, updateLastActiveTurnNumber, getTurnById, getMessageById, getLastMessageBySender, getActiveTurn, getMaxTurnNumber: conversationRepo.getMaxTurnNumber as ReturnType<typeof vi.fn> };
}

/** 提取 mock 首次调用的参数（避免 toHaveBeenCalledWith 绑定实现细节的 lint 规则） */
function firstCallArgs(fn: ReturnType<typeof vi.fn>): unknown[] {
  return (fn.mock.calls[0] as unknown[]) ?? [];
}

describe("DispatchChainEngine markBatchRead（F20260803trrf: 时序修复）", () => {
  it("fulfilled 结果：turn 已关闭时仍用 turnId 反查推进 last_read", async () => {
    const m = makeMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-1"],
      invokeFn: async () => ({ messageId: "m-1" }),
    });

    /** 核心修复点：不依赖 getActiveTurn（turn 已关闭返回 null） */
    expect(m.getActiveTurn).not.toHaveBeenCalled();
    expect(m.getTurnById).toHaveBeenCalled();
    expect(m.updateLastReadTurnNumber).toHaveBeenCalled();
    const [convId, otterId, turnNum] = firstCallArgs(m.updateLastReadTurnNumber);
    expect([convId, otterId, turnNum]).toEqual(["conv-1", "otter-1", 5]);
    // F20260819idnw: 小獭发言时同时更新 lastActiveTurnNumber
    expect(m.updateLastActiveTurnNumber).toHaveBeenCalled();
    const [aConvId, aOtterId, aTurnNum] = firstCallArgs(m.updateLastActiveTurnNumber);
    expect([aConvId, aOtterId, aTurnNum]).toEqual(["conv-1", "otter-1", 5]);
  });

  it("rejected 结果：用 getLastMessageBySender 反查仍推进 last_read", async () => {
    const m = makeMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-1"],
      invokeFn: async () => { throw new Error("invoke failed"); },
    });

    expect(m.getLastMessageBySender).toHaveBeenCalled();
    const [rConvId, rOtterId] = firstCallArgs(m.getLastMessageBySender);
    expect([rConvId, rOtterId]).toEqual(["conv-1", "otter-1"]);
    expect(m.updateLastReadTurnNumber).toHaveBeenCalled();
  });

  it("getTurnById 返回 null 时不推进（防御性）", async () => {
    const m = makeMocks();
    m.getTurnById.mockResolvedValue(null);
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-1"],
      invokeFn: async () => ({ messageId: "m-1" }),
    });

    expect(m.updateLastReadTurnNumber).not.toHaveBeenCalled();
  });

  it("多 targets：各自 last_read 独立推进到自己的 turn", async () => {
    const m = makeMocks();
    m.getMessageById.mockImplementation(async (id: string) => {
      if (id === "m-1") return makeMsg({ id: "m-1", senderId: "otter-1", turnId: "turn-1" });
      if (id === "m-2") return makeMsg({ id: "m-2", senderId: "otter-2", turnId: "turn-2" });
      return null;
    });
    m.getTurnById.mockImplementation(async (turnId: string) => {
      if (turnId === "turn-1") return makeTurn({ id: "turn-1", turnNumber: 5 });
      if (turnId === "turn-2") return makeTurn({ id: "turn-2", turnNumber: 7 });
      return null;
    });
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-1", "otter-2"],
      invokeFn: async ({ otterId }) => ({ messageId: otterId === "otter-1" ? "m-1" : "m-2" }),
    });

    const calls = m.updateLastReadTurnNumber.mock.calls as Array<[string, string, number]>;
    expect(calls).toHaveLength(2);
    const byOtter = new Map(calls.map(([, otterId, turnNum]) => [otterId, turnNum]));
    expect(byOtter.get("otter-1")).toBe(5);
    expect(byOtter.get("otter-2")).toBe(7);
  });
});

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
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

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
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

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

  it("自指回声防环：小獭 yield 回自己时链终止于本轮（不无限循环）", async () => {
    const { m } = makeChainMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger, maxChainDepth: 10 });
    const invoked: string[] = [];

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "owner-otter",
      initialTargets: ["otter-worker"],
      /** 小獭持续 yield 回自己（工具层 validateAndResolve 应拦截，链层验证不因此死循环） */
      invokeFn: async ({ otterId }: { otterId: string }) => {
        invoked.push(otterId);
        return { messageId: "m-work", aggregatedTargets: ["otter-worker"] };
      },
    });

    /** 行为契约：自指目标不再引发新一轮 invoke（executeOneHop 逐批派发，同批内目标只 invoke 一次后靠下一轮终止）。
     *  修复后 senderId 不再参与过滤，自指唯一终止保障是链层：invoke 幂等去重（同 hop 不重派）。 */
    expect(invoked.length).toBeLessThanOrEqual(10);
    expect(invoked[0]).toBe("otter-worker");
  });
});

describe("buildIdleOttersWarning", () => {
  function makeParticipant(overrides: Record<string, unknown> = {}) {
    return {
      otterId: "otter-1",
      status: "active",
      lastActiveTurnNumber: 0,
      lastReadTurnNumber: 0,
      ...overrides,
    };
  }

  it("有闲置小獭时返回正确预警文本", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x", lastActiveTurnNumber: 1 }),
      makeParticipant({ otterId: "otter-current", lastActiveTurnNumber: 20 }),
    ]);
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "otter-x") return { name: "闲置獭" };
      if (id === "otter-current") return { name: "当前獭" };
      return null;
    });
    m.getMaxTurnNumber.mockResolvedValue(25);
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const result = await engine.buildIdleOttersWarning("conv-1", "otter-current");
    expect(result).toContain("闲置獭");
    expect(result).toContain("24 轮");
    expect(result).toContain("系统提示");
  });

  it("无闲置小獭时返回 null", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x", lastActiveTurnNumber: 20 }),
    ]);
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "活跃獭" });
    m.getMaxTurnNumber.mockResolvedValue(25);
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const result = await engine.buildIdleOttersWarning("conv-1", "user-1");
    expect(result).toBeNull();
  });

  it("getMaxTurnNumber 返回 0 时返回 null", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    m.getMaxTurnNumber.mockResolvedValue(0);
    const result = await engine.buildIdleOttersWarning("conv-1", "user-1");
    expect(result).toBeNull();
  });

  it("从 settingsRepo 读取自定义阈值", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x", lastActiveTurnNumber: 1 }),
    ]);
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "獭" });
    m.getMaxTurnNumber.mockResolvedValue(10);
    const settingsRepo = { get: vi.fn().mockResolvedValue("5") };
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger, settingsRepo: settingsRepo as never });
    // idleTurns = 10 - 1 = 9, threshold = 5 → 超过
    const result = await engine.buildIdleOttersWarning("conv-1", "user-1");
    expect(result).toContain("獭");
    expect(result).toContain("9 轮");
  });

  it("settingsRepo 不可用时 fallback 到默认阈值 20", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x", lastActiveTurnNumber: 1 }),
    ]);
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "獭" });
    m.getMaxTurnNumber.mockResolvedValue(25);
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    // idleTurns = 25 - 1 = 24, threshold = 20 → 超过
    const result = await engine.buildIdleOttersWarning("conv-1", "user-1");
    expect(result).toContain("24 轮");
  });

  it("无效阈值配置 fallback 到默认值 20", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeParticipant({ otterId: "otter-x", lastActiveTurnNumber: 1 }),
    ]);
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "獭" });
    m.getMaxTurnNumber.mockResolvedValue(25);
    const settingsRepo = { get: vi.fn().mockResolvedValue("abc") };
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger, settingsRepo: settingsRepo as never });
    // idleTurns = 24, threshold fallback 20 → 超过
    const result = await engine.buildIdleOttersWarning("conv-1", "user-1");
    expect(result).toContain("24 轮");
  });
});

describe("buildMessageWithContext 闲置预警集成", () => {
  it("无未读消息时仍注入闲置预警（早返回路径）", async () => {
    const m = makeMocks();
    (m.conversationRepo.getActiveParticipants as ReturnType<typeof vi.fn>).mockResolvedValue([
      { otterId: "otter-x", status: "active", lastActiveTurnNumber: 1, lastReadTurnNumber: 0 },
    ]);
    m.getMaxTurnNumber.mockResolvedValue(25);
    (m.queryOtter.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "闲置獭" });
    // 无未读消息
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const result = await engine.buildMessageWithContext("conv-1", "user-1", "hi", "user-1", "## 在场成员\n- user'");

    expect(result).toContain("闲置獭");
    expect(result).toContain("24 轮");
    expect(result).toContain("## 当前任务");
  });

  it("F20260829cach: 两条路径都注入分钟级当前时间（补偿 system prompt 日粒度锚点）", async () => {
    const m = makeMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });

    // 路径 1：无未读消息（早返回）
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const noUnread = await engine.buildMessageWithContext("conv-1", "user-1", "hi", "user-1", "## 在场成员");
    expect(noUnread).toMatch(/## 当前时间\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2}（Asia\/Shanghai）/);
    expect(noUnread.indexOf("## 当前时间")).toBeGreaterThan(noUnread.indexOf("## 在场成员"));
    expect(noUnread.indexOf("## 当前任务")).toBeGreaterThan(noUnread.indexOf("## 当前时间"));

    // 路径 2：有未读消息
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "otter", senderId: "otter-1", senderName: "Test Otter", segments: [{ body: "msg" }] },
    ]);
    const withUnread = await engine.buildMessageWithContext("conv-1", "user-1", "hi", "user-1", "## 在场成员");
    expect(withUnread).toMatch(/## 当前时间\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2}（Asia\/Shanghai）/);
    expect(withUnread.indexOf("## 当前任务")).toBeGreaterThan(withUnread.indexOf("## 当前时间"));
  });

  it("buildIdleOttersWarning 抛异常时不影响主流程", async () => {
    const m = makeMocks();
    // getMaxTurnNumber 抛异常触发 buildIdleOttersWarning 的 try-catch
    (m.conversationRepo as unknown as { getMaxTurnNumber: ReturnType<typeof vi.fn> }).getMaxTurnNumber.mockRejectedValue(new Error("db error"));
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "otter", senderId: "otter-1", senderName: "Test Otter", segments: [{ body: "msg" }] },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const result = await engine.buildMessageWithContext("conv-1", "user-1", "hi", "user-1", "## 在场成员");

    // 预警失败不影响主流程，结果仍包含对话历史和当前任务
    expect(result).toContain("## 对话历史");
    expect(result).toContain("## 当前任务");
    expect(result).not.toContain("系统提示");
  });
});

describe("buildMessageWithContext user 姓名快照（F20260826fuid: 飞书群聊多人识别）", () => {
  it("user 消息带 senderName 快照时用快照名渲染", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "ou_zhangsan", senderName: "张三", segments: [{ body: "我是张三的消息" }] },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[张三] 我是张三的消息");
  });

  it("多条 user 消息不同快照名可区分", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "ou_zhangsan", senderName: "张三", segments: [{ body: "第一条" }] },
      { senderType: "user", senderId: "ou_lisi", senderName: "李四", segments: [{ body: "第二条" }] },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[张三] 第一条");
    expect(result).toContain("[李四] 第二条");
  });

  it("当前 sender 无快照时回退「搭档」标签", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "ou_lisi", senderName: "", segments: [{ body: "在吗" }] },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[搭档] 在吗");
  });

  it("其他 user 发言者无快照时保留裸 open_id（不冒充搭档）", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "ou_zhangsan", senderName: "", segments: [{ body: "我是谁" }] },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[ou_zhangsan] 我是谁");
    expect(result).not.toContain("[搭档] 我是谁");
  });

  it("快照名仅空白时视为无快照", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "ou_lisi", senderName: "   ", segments: [{ body: "在吗" }] },
    ]);

    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_lisi", "## 在场成员");

    expect(result).toContain("[搭档] 在吗");
  });
});

describe("buildMessageWithContext 搭档静态绑定（F20260826fpbd）", () => {
  function makeEngine(m: ReturnType<typeof makeMocks>, partnerOpenId: string | undefined) {
    return new DispatchChainEngine({
      conversationRepo: m.conversationRepo,
      queryMessage: m.queryMessage,
      queryOtter: m.queryOtter,
      logger: m.logger,
      partnerResolver: new PartnerResolver(partnerOpenId),
    });
  }

  it("静态模式：配置的搭档 open_id → partnerLabel，即使非本次 sender", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "ou_chen", senderName: "", segments: [{ body: "看看这个" }] },
    ]);

    // joy 触发本次派发，但历史里 chen 的消息仍标搭档（静态锚定，不随说话者变）
    const engine = makeEngine(m, "ou_chen");
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_joy", "## 在场成员");

    expect(result).toContain("[搭档] 看看这个");
  });

  it("静态模式：访客触发本次派发也无 partnerLabel（动态推断旧病修复）", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "ou_joy", senderName: "", segments: [{ body: "我也觉得行" }] },
    ]);

    const engine = makeEngine(m, "ou_chen");
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_joy", "## 在场成员");

    expect(result).toContain("[ou_joy] 我也觉得行");
    expect(result).not.toContain("[搭档] 我也觉得行");
  });

  it("静态模式：访客有快照名时显示真名", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "ou_joy", senderName: "Joy", segments: [{ body: "哈哈" }] },
    ]);

    const engine = makeEngine(m, "ou_chen");
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_joy", "## 在场成员");

    expect(result).toContain("[Joy] 哈哈");
  });

  it("静态模式：Web 'user' 恒为搭档", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "user", senderName: "", segments: [{ body: "Web 来的" }] },
    ]);

    const engine = makeEngine(m, "ou_chen");
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "user", "## 在场成员");

    expect(result).toContain("[搭档] Web 来的");
  });

  it("降级（未配置）：维持 #488 行为——当前 sender 无快照仍标搭档", async () => {
    const m = makeMocks();
    (m.conversationRepo.getUnreadMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { senderType: "user", senderId: "ou_joy", senderName: "", segments: [{ body: "在吗" }] },
    ]);

    const engine = makeEngine(m, undefined);
    const result = await engine.buildMessageWithContext("conv-1", "otter-1", "hi", "ou_joy", "## 在场成员");

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
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
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

describe("sgp2 hop 取源修复（F20260902sgp2 #712：hop 2+ 记账 + 多源覆盖）", () => {
  /** 复现生产观察 2026-09-02：hop 局部 Map 回填即丢 → hop 2+ 记账全跳过 → 虚 pending */
  function makeLedgerMocks() {
    const m = makeMocks();
    const attempts: Array<{ messageId: string; target: string; status: string }> = [];
    const dispatchAttemptRepo = {
      recordStart: (a: { messageId: string; targetOtterId: string }) => {
        attempts.push({ messageId: a.messageId, target: a.targetOtterId, status: "in_progress" });
      },
      recordFinish: (messageId: string, target: string, status: string) => {
        const row = attempts.find(x => x.messageId === messageId && x.target === target && x.status === "in_progress");
        if (row) row.status = status;
      },
      backfillLegacyAttempted: () => 0,
      countPendingSignals: () => 0,
      listPendingSignals: () => [],
      markStaleInProgressFailed: () => 0,
      listAttemptsForConversation: () => [],
    };
    return { m, attempts, dispatchAttemptRepo };
  }

  it("hop 2+ 记账不再跳过：小獭 yield 属主，属主被记为消费触发消息 m-work", async () => {
    const { m, attempts, dispatchAttemptRepo } = makeLedgerMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger, dispatchAttemptRepo });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      triggerMessageId: "m-user",
      invokeFn: async ({ otterId }) => {
        if (otterId === "otter-worker") return { messageId: "m-work", aggregatedTargets: ["owner-otter"] };
        return { messageId: "m-owner" };
      },
    });

    // hop1: (m-user, otter-worker)；hop2: (m-work, owner-otter) ——修复前 hop2 无记账
    const hop2 = attempts.find(a => a.messageId === "m-work" && a.target === "owner-otter");
    expect(hop2).toBeDefined();
    expect(hop2!.status).toBe("completed");
    const hop1 = attempts.find(a => a.messageId === "m-user" && a.target === "otter-worker");
    expect(hop1!.status).toBe("completed");
  });

  it("多源覆盖：A、B 同 hop yield 给 C，C 对两条触发消息各记一条 attempt", async () => {
    const { m, attempts, dispatchAttemptRepo } = makeLedgerMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger, dispatchAttemptRepo });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-a", "otter-b"],
      invokeFn: async ({ otterId }) => {
        if (otterId === "otter-a") return { messageId: "m-a", aggregatedTargets: ["otter-c"] };
        if (otterId === "otter-b") return { messageId: "m-b", aggregatedTargets: ["otter-c"] };
        return { messageId: "m-c" };
      },
    });

    // hop2 的 C 需记 (m-a, C) 和 (m-b, C) 两条——消费义务逐条销账
    const forC = attempts.filter(a => a.target === "otter-c");
    expect(forC.map(a => a.messageId).sort()).toEqual(["m-a", "m-b"]);
    expect(forC.every(a => a.status === "completed")).toBe(true);
  });

  it("无 repo 时不记账也不抛（可选依赖，零行为变化）", async () => {
    const { m } = makeLedgerMocks();
    const engine = new DispatchChainEngine({ conversationRepo: m.conversationRepo, queryMessage: m.queryMessage, queryOtter: m.queryOtter, logger: m.logger });
    const invoked: string[] = [];

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      invokeFn: async ({ otterId }) => {
        invoked.push(otterId);
        if (otterId === "otter-worker") return { messageId: "m-work", aggregatedTargets: ["owner-otter"] };
        return { messageId: "m-owner" };
      },
    });

    expect(invoked).toEqual(["otter-worker", "owner-otter"]); // 链路行为不变
  });
});
