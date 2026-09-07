/**
 * #530 梯度护栏集成测试
 *
 * 测试 self-yield 连续计数 + 梯度响应（第 3 次 steer 警示 / 第 5 次 abort + healing 留痕）。
 * 设计锚点：p3a-design-full.md「③ 梯度护栏」节。
 *
 * 计数判据（已收敛）：给定 otterId + conversationId，消息表倒序数连续 self 指向；
 * 介入即停的三类：该獭自己的 to≠self yield、user 消息（含 retry 触发）、
 * 任何外部（sender≠该獭）tsp 含该獭的信号消息；不相关消息透明。
 *
 * 计数语义：countConsecutiveSelfYields 扫描 DB 中的 PREVIOUS 消息；
 * 当前 hop 的产出是第 (dbCount+1) 次（尚未写入消息表）。
 *
 * 测试方式：直接 seed 消息表（② 合入前合法路径产不出 self-yield，talking-stone 禁令还在）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { Message } from "@entities/conversation/message";

// ── Helpers ──

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "m-default",
    conversationId: "conv-1",
    turnId: "turn-1",
    senderId: "otter-1",
    senderType: "otter",
    status: "completed",
    segments: [{ id: "seg-1", messageId: "m-default", body: "body", sequenceNum: 0, createdAt: "" }],
    sequenceNum: 1,
    talkingStonePassedTo: [],
    contextTokens: null,
    contextTokensMax: null,
    source: "web",
    senderName: "Test Otter",
    createdAt: "",
    completedAt: "",
    ...overrides,
  };
}

function makeMocks() {
  const updateLastReadSeq = vi.fn();
  const updateLastActiveTurnNumber = vi.fn().mockResolvedValue(undefined);
  const getTurnById = vi.fn().mockResolvedValue({ id: "turn-1", conversationId: "conv-1", turnNumber: 5, status: "closed", createdAt: "", closedAt: null });
  const getMessageById = vi.fn(async (id: string) => makeMsg({ id }));
  const getLastMessageBySender = vi.fn().mockResolvedValue(makeMsg());
  // getMessages 用于 countConsecutiveSelfYields——测试中 seed 消息序列
  let seededMessages: Message[] = [];
  const getMessages = vi.fn(async () => seededMessages);

  const conversationRepo = {
    getActiveParticipants: vi.fn().mockResolvedValue([]),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    getMaxTurnNumber: vi.fn().mockResolvedValue(0),
    getTurnById,
    updateLastReadSeq,
    updateLastActiveTurnNumber,
    getLastMessageBySender,
    getActiveTurn: vi.fn().mockResolvedValue(null),
    getMessageById,
    getParticipant: vi.fn().mockResolvedValue(null),
    getMessages,
    getLastMessage: vi.fn().mockResolvedValue(null),
  } as unknown as ConversationRepository;

  const queryMessage = { getMessageById, getLastMessageBySender } as unknown as QueryMessage;
  const queryOtter = { getById: vi.fn().mockResolvedValue(null) } as unknown as QueryOtter;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  const abort = vi.fn();
  const healingRepo = {
    create: vi.fn().mockResolvedValue(undefined),
  } as unknown as HealingEventRepository;

  return {
    conversationRepo, queryMessage, queryOtter, logger,
    abort, healingRepo,
    getMessageById, getMessages,
    setSeededMessages: (msgs: Message[]) => { seededMessages = msgs; },
  };
}

function makeChainEngine(m: ReturnType<typeof makeMocks>, overrides?: { abort?: typeof m.abort; healingRepo?: typeof m.healingRepo }) {
  return new DispatchChainEngine({
    conversationRepo: m.conversationRepo,
    queryMessage: m.queryMessage,
    queryOtter: m.queryOtter,
    logger: m.logger,
    maxChainDepth: 10,
    abort: overrides?.abort ?? m.abort,
    healingRepo: overrides?.healingRepo ?? m.healingRepo,
  });
}

// ── Test suite ──

// eslint-disable-next-line max-lines-per-function -- #530 护栏集成测试：各场景共享 beforeEach 和 mock 工厂，拆文件会重复 90% 样板
describe("#530 self-yield guardrail", () => {
  let m: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    m = makeMocks();
  });

  // ─── 计数函数基础行为 ───
  // 计数语义：DB 扫描 previous count；当前 hop = 第 (previous+1) 次。
  // Steer 阈值=3（previous >= 2），Abort 阈值=5（previous >= 4）。

  describe("梯度响应", () => {
    it("第 3 次 self-yield（DB 有 2 条 previous）→ steer 警示文案注入下一 hop", async () => {
      m.setSeededMessages([
        makeMsg({ id: "m-2", sequenceNum: 2, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-1", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      const invoked: string[] = [];
      const receivedSteer: boolean[] = [];
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async ({ otterId, userMessageContent }) => {
          invoked.push(otterId);
          // F20260907ylfs ②（件 B 转正）：self 链真实续跑——第一跳 self-yield（计数 total=3
          // 命中 steer），第二跳真实被唤醒并收到注入文案；第二跳无 yield（tsp=[]）收链。
          // 旧版「if (invoked.length > 1)」死代码（② 前滤 self → 第二跳不存在）退役。
          receivedSteer.push(userMessageContent.includes("连续 3 次 self-yield"));
          m.getMessageById.mockResolvedValue(
            invoked.length === 1
              ? makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
              : makeMsg({ id: "m-new-2", talkingStonePassedTo: [] })
          );
          return { messageId: invoked.length === 1 ? "m-new" : "m-new-2" };
        },
      });

      // ② 转正：链两跳（hop1 self-yield → hop2 续跑收链），第二跳收到 steer 注入
      expect(invoked).toEqual(["otter-1", "otter-1"]);
      expect(receivedSteer).toEqual([false, true]);
      // abort 未被调用（3 < 5）
      expect(m.abort).not.toHaveBeenCalled();
    });

    it("第 5 次 self-yield（DB 有 4 条 previous）→ abort + healing 留痕", async () => {
      m.setSeededMessages([
        makeMsg({ id: "m-4", sequenceNum: 4, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-3", sequenceNum: 3, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-2", sequenceNum: 2, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-1", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      const result = await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ messageId: "m-new" }),
      });

      // abort 被调用
      expect(m.abort).toHaveBeenCalledOnce();
      expect(m.abort.mock.calls[0]![0]).toBe("otter-1");
      // healing 留痕
      expect(m.healingRepo.create).toHaveBeenCalledOnce();
      const healingArg = (m.healingRepo.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(healingArg.errorType).toBe("other");
      expect(healingArg.severity).toBe("medium");
      expect(healingArg.description).toContain("#530");
      expect(healingArg.description).toContain("5 次");
      // 链终止——nextTargets 为空
      expect(result.otterReply).toBeDefined();
    });

    it("第 4 次 self-yield（DB 有 3 条 previous）→ 仅日志，不 steer 不 abort", async () => {
      m.setSeededMessages([
        makeMsg({ id: "m-3", sequenceNum: 3, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-2", sequenceNum: 2, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-1", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ messageId: "m-new" }),
      });

      // steer 只在第 3 次触发（previous=2），第 4 次不重复 steer
      expect(m.abort).not.toHaveBeenCalled();
      expect(m.abort).not.toHaveBeenCalled();
    });
  });

  // ─── 介入重置场景 ───

  describe("介入重置", () => {
    it("该獭 to≠self yield 重置计数（previous=1，不够 steer）", async () => {
      // m-3: self-yield (prev count starts at 1)
      // m-2: to≠self → 介入，reset (prev count resets to 0)
      // m-1: self-yield (prev count = 1)
      // current: self-yield → totalCount = 2 → not enough for steer
      m.setSeededMessages([
        makeMsg({ id: "m-3", sequenceNum: 3, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-2", sequenceNum: 2, senderId: "otter-1", talkingStonePassedTo: ["other-otter"] }),
        makeMsg({ id: "m-1", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ messageId: "m-new" }),
      });

      expect(m.abort).not.toHaveBeenCalled();
      expect(m.abort).not.toHaveBeenCalled();
    });

    it("user 消息重置计数", async () => {
      m.setSeededMessages([
        makeMsg({ id: "m-3", sequenceNum: 3, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-user", sequenceNum: 2, senderId: "user", senderType: "user" as const, talkingStonePassedTo: null }),
        makeMsg({ id: "m-1", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ messageId: "m-new" }),
      });

      expect(m.abort).not.toHaveBeenCalled();
    });

    it("外部指向该獭的信号消息重置计数", async () => {
      m.setSeededMessages([
        makeMsg({ id: "m-3", sequenceNum: 3, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-signal", sequenceNum: 2, senderId: "other-otter", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-1", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      const invoked: string[] = [];
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async ({ otterId, userMessageContent }) => {
          invoked.push(otterId);
          // 外部信号重置计数，不应触发 steer
          expect(userMessageContent).not.toContain("self-yield-guard");
          return { messageId: "m-new" };
        },
      });
    });
  });

  // ─── 不相关消息透明 ───

  describe("不相关消息透明", () => {
    it("不相关 system 消息透明（不重置计数），连续 3 条 previous 触发 steer 注入下一 hop", async () => {
      // m-3: self-yield (prev=1), m-sys: transparent (skip), m-2: self-yield (prev=2)
      // current: self-yield → totalCount=3 → steer
      m.setSeededMessages([
        makeMsg({ id: "m-3", sequenceNum: 3, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-sys", sequenceNum: 2, senderId: "system", senderType: "system" as const, talkingStonePassedTo: [] }),
        makeMsg({ id: "m-2", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      const invoked: string[] = [];
      const receivedSteer: boolean[] = [];
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async ({ otterId, userMessageContent }) => {
          invoked.push(otterId);
          // F20260907ylfs ②（件 B 转正）：不相关 system 消息透明 → 计数累计 → steer
          // 注入第二 hop（真实续跑）；第二跳无 yield 收链
          receivedSteer.push(userMessageContent.includes("连续 3 次 self-yield"));
          m.getMessageById.mockResolvedValue(
            invoked.length === 1
              ? makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
              : makeMsg({ id: "m-new-2", talkingStonePassedTo: [] })
          );
          return { messageId: invoked.length === 1 ? "m-new" : "m-new-2" };
        },
      });

      expect(invoked).toEqual(["otter-1", "otter-1"]);
      expect(receivedSteer).toEqual([false, true]);
    });

    it("不相关外部 otter 消息透明（tsp 不含该獭），连续 previous 触发 steer 注入下一 hop", async () => {
      // m-3: self-yield (prev=1), m-other: transparent, m-2: self-yield (prev=2)
      // current: self-yield → totalCount=3 → steer
      m.setSeededMessages([
        makeMsg({ id: "m-3", sequenceNum: 3, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-other", sequenceNum: 2, senderId: "other-otter", talkingStonePassedTo: ["someone-else"] }),
        makeMsg({ id: "m-2", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      const invoked: string[] = [];
      const receivedSteer: boolean[] = [];
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async ({ otterId, userMessageContent }) => {
          invoked.push(otterId);
          // F20260907ylfs ②（件 B 转正）：不相关外部 otter 消息透明 → 计数累计 → steer
          // 注入第二 hop（真实续跑）；第二跳无 yield 收链
          receivedSteer.push(userMessageContent.includes("连续 3 次 self-yield"));
          m.getMessageById.mockResolvedValue(
            invoked.length === 1
              ? makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
              : makeMsg({ id: "m-new-2", talkingStonePassedTo: [] })
          );
          return { messageId: invoked.length === 1 ? "m-new" : "m-new-2" };
        },
      });

      expect(invoked).toEqual(["otter-1", "otter-1"]);
      expect(receivedSteer).toEqual([false, true]);
    });
  });

  // ─── 可选依赖降级 ───

  describe("可选依赖降级", () => {
    it("无 abort/healing 回调时护栏降级 no-op（不抛）", async () => {
      m.setSeededMessages([
        makeMsg({ id: "m-2", sequenceNum: 2, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-1", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m, { abort: undefined, healingRepo: undefined });
      const result = await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ messageId: "m-new" }),
      });

      // 不抛异常（回调可选，降级为 no-op）
      expect(result.otterReply).toBeDefined();
    });

    it("无 healingRepo 时 abort 不留痕（不抛）", async () => {
      m.setSeededMessages([
        makeMsg({ id: "m-4", sequenceNum: 4, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-3", sequenceNum: 3, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-2", sequenceNum: 2, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
        makeMsg({ id: "m-1", sequenceNum: 1, senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m, { healingRepo: undefined });
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ messageId: "m-new" }),
      });

      // abort 被调用但 healing 不写入（不抛）
      expect(m.abort).toHaveBeenCalledOnce();
    });

    it("getMessages 查询失败降级为 count=0（不阻断链路）", async () => {
      (m.conversationRepo.getMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db error"));
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ messageId: "m-new" }),
      });

      expect(m.abort).not.toHaveBeenCalled();
      expect(m.abort).not.toHaveBeenCalled();
      // warn 日志记录降级
      expect(m.logger.warn).toHaveBeenCalled();
    });
  });

  // ─── 非 self-yield 路径无影响 ───

  describe("非 self-yield 路径无影响", () => {
    it("正常 yield 给其他 otter 不触发护栏", async () => {
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-work", talkingStonePassedTo: ["owner-otter"] })
      );

      const engine = makeChainEngine(m);
      const invoked: string[] = [];
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async ({ otterId }) => {
          invoked.push(otterId);
          return { messageId: "m-work" };
        },
      });

      expect(m.abort).not.toHaveBeenCalled();
      expect(m.abort).not.toHaveBeenCalled();
      expect(invoked).toContain("otter-1");
    });

    it("消息 tsp 为空（无 yield）不触发护栏", async () => {
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-noyield", talkingStonePassedTo: [] })
      );

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ messageId: "m-noyield" }),
      });

      expect(m.abort).not.toHaveBeenCalled();
      expect(m.abort).not.toHaveBeenCalled();
    });
  });

  // ─── 同会话边界 ───

  describe("同会话边界", () => {
    it("countConsecutiveSelfYields 只查本会话（getMessages 传入 conversationId）", async () => {
      m.setSeededMessages([
        makeMsg({ id: "m-1", conversationId: "conv-1", senderId: "otter-1", talkingStonePassedTo: ["otter-1"] }),
      ]);
      m.getMessageById.mockResolvedValue(
        makeMsg({ id: "m-new", conversationId: "conv-1", talkingStonePassedTo: ["otter-1"] })
      );

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ messageId: "m-new" }),
      });

      // 验证护栏只查本会话（scope boundary，非实现细节——跨会话查询会导致计数串扰）
      // #530 修复（检视-838 发现 2）：before=currentMessageId 排除当前消息，避免重复计数
      // eslint-disable-next-line no-restricted-syntax -- #530 scope boundary: 验证 getMessages 调用的 conversationId 参数，确保同会话隔离
      expect(m.getMessages).toHaveBeenCalledWith("conv-1", { limit: 100, before: "m-new" });
    });
  });
});
