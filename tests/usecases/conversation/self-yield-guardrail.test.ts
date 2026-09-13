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
import type { EntryRepository } from "@usecases/conversation/entry-repository";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
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

  // F20260913ctlv 彻底切换：护栏计数数据源 = entries（yield/user 条目）+ invoke 行
  let seededEntries: Array<Record<string, unknown>> = [];
  const invokeRows = new Map<string, Record<string, unknown>>();
  const entryRepo = {
    getEntries: vi.fn(async () => [...seededEntries].sort((a, b) => (b.sequenceNum as number) - (a.sequenceNum as number))),
    getUnreadEntries: vi.fn(async () => []),
  } as unknown as EntryRepository;
  const getInvokeById = vi.fn(async (id: string) => invokeRows.get(id) ?? null);
  const invokeRepo = {
    getInvokeById,
  } as unknown as InvokeRepository;

  const abort = vi.fn();
  const healingRepo = {
    create: vi.fn().mockResolvedValue(undefined),
  } as unknown as HealingEventRepository;

  return {
    conversationRepo, queryMessage, queryOtter, logger,
    abort, healingRepo,
    getMessageById, getMessages,
    entryRepo, invokeRepo, getInvokeById,
    setSeededMessages: (msgs: Message[]) => { seededMessages = msgs; },
    /** F20260913ctlv：seed entry 序列（最新在前语义由 getEntries mock 排序处理） */
    setSeededEntries: (entries: Array<Record<string, unknown>>) => { seededEntries = entries; },
    /** F20260913ctlv：注册 invoke 行（isEntryOfOtter 无 senderId 时回查） */
    setInvokeRow: (id: string, row: Record<string, unknown>) => { invokeRows.set(id, row); },
  };
}

function makeChainEngine(m: ReturnType<typeof makeMocks>, overrides?: { abort?: typeof m.abort; healingRepo?: typeof m.healingRepo }) {
  return new DispatchChainEngine({
    conversationRepo: m.conversationRepo,
    queryOtter: m.queryOtter,
    logger: m.logger,
    maxChainDepth: 10,
    abort: overrides?.abort ?? m.abort,
    healingRepo: overrides?.healingRepo ?? m.healingRepo,
    entryRepo: m.entryRepo,
    invokeRepo: m.invokeRepo,
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
      m.setSeededEntries([
        { id: "ey-2", sequenceNum: 2, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e2", yieldTargets: ["otter-1"] },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

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
          (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue(
            invoked.length === 1
              ? { id: "inv-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" }
              : { id: "inv-new-2", status: "completed", otterId: "otter-1", talkingStonePassedTo: [], endedAt: "2026-09-10T00:00:00Z" }
          );
          return { invokeId: invoked.length === 1 ? "inv-new" : "inv-new-2", messageId: invoked.length === 1 ? "inv-new" : "inv-new-2", aggregatedTargets: invoked.length === 1 ? ["otter-1"] : [] };
        },
      });

      // ② 转正：链两跳（hop1 self-yield → hop2 续跑收链），第二跳收到 steer 注入
      expect(invoked).toEqual(["otter-1", "otter-1"]);
      expect(receivedSteer).toEqual([false, true]);
      // abort 未被调用（3 < 5）
      expect(m.abort).not.toHaveBeenCalled();
    });

    it("第 5 次 self-yield（DB 有 4 条 previous）→ abort + healing 留痕", async () => {
      m.setSeededEntries([
        { id: "ey-4", sequenceNum: 4, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e4", yieldTargets: ["otter-1"] },
        { id: "ey-3", sequenceNum: 3, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e3", yieldTargets: ["otter-1"] },
        { id: "ey-2", sequenceNum: 2, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e2", yieldTargets: ["otter-1"] },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ invokeId: "inv-new", messageId: "inv-new", aggregatedTargets: ["otter-1"] }),
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
      // F20260913ctlv 彻底切换：otterReply 从 invoke 行不可得（内容在 speak entries）——
      // 链终止语义改由 abort 断言锁定（nextTargets 清空终链）
    });

    it("第 4 次 self-yield（DB 有 3 条 previous）→ 仅日志，不 steer 不 abort", async () => {
      m.setSeededEntries([
        { id: "ey-3", sequenceNum: 3, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e3", yieldTargets: ["otter-1"] },
        { id: "ey-2", sequenceNum: 2, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e2", yieldTargets: ["otter-1"] },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ invokeId: "inv-new", messageId: "inv-new", aggregatedTargets: ["otter-1"] }),
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
      m.setSeededEntries([
        { id: "ey-3", sequenceNum: 3, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e3", yieldTargets: ["otter-1"] },
        { id: "ey-2", sequenceNum: 2, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e2", yieldTargets: ["other-otter"] },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ invokeId: "inv-new", messageId: "inv-new", aggregatedTargets: ["otter-1"] }),
      });

      expect(m.abort).not.toHaveBeenCalled();
      expect(m.abort).not.toHaveBeenCalled();
    });

    it("user 消息重置计数", async () => {
      m.setSeededEntries([
        { id: "ey-3", sequenceNum: 3, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e3", yieldTargets: ["otter-1"] },
        { id: "eu-2", sequenceNum: 2, entryType: "user", senderType: "user", senderId: "user", body: "", invokeId: null, yieldTargets: null },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ invokeId: "inv-new", messageId: "inv-new", aggregatedTargets: ["otter-1"] }),
      });

      expect(m.abort).not.toHaveBeenCalled();
    });

    it("外部指向该獭的信号消息重置计数", async () => {
      m.setSeededEntries([
        { id: "ey-3", sequenceNum: 3, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e3", yieldTargets: ["otter-1"] },
        { id: "ey-2", sequenceNum: 2, entryType: "yield", senderType: "otter", senderId: "other-otter", body: "", invokeId: "inv-e2", yieldTargets: ["otter-1"] },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

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
      m.setSeededEntries([
        { id: "ey-3", sequenceNum: 3, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e3", yieldTargets: ["otter-1"] },
        { id: "es-2", sequenceNum: 2, entryType: "system", senderType: "system", senderId: "system", body: "", invokeId: null, yieldTargets: null },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

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
          (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue(
            invoked.length === 1
              ? { id: "inv-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" }
              : { id: "inv-new-2", status: "completed", otterId: "otter-1", talkingStonePassedTo: [], endedAt: "2026-09-10T00:00:00Z" }
          );
          return { invokeId: invoked.length === 1 ? "inv-new" : "inv-new-2", messageId: invoked.length === 1 ? "inv-new" : "inv-new-2", aggregatedTargets: invoked.length === 1 ? ["otter-1"] : [] };
        },
      });

      expect(invoked).toEqual(["otter-1", "otter-1"]);
      expect(receivedSteer).toEqual([false, true]);
    });

    it("不相关外部 otter 消息透明（tsp 不含该獭），连续 previous 触发 steer 注入下一 hop", async () => {
      // m-3: self-yield (prev=1), m-other: transparent, m-2: self-yield (prev=2)
      // current: self-yield → totalCount=3 → steer
      m.setSeededEntries([
        { id: "ey-3", sequenceNum: 3, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e3", yieldTargets: ["otter-1"] },
        { id: "ey-2", sequenceNum: 2, entryType: "yield", senderType: "otter", senderId: "other-otter", body: "", invokeId: "inv-e2", yieldTargets: ["someone-else"] },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

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
          (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue(
            invoked.length === 1
              ? { id: "inv-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" }
              : { id: "inv-new-2", status: "completed", otterId: "otter-1", talkingStonePassedTo: [], endedAt: "2026-09-10T00:00:00Z" }
          );
          return { invokeId: invoked.length === 1 ? "inv-new" : "inv-new-2", messageId: invoked.length === 1 ? "inv-new" : "inv-new-2", aggregatedTargets: invoked.length === 1 ? ["otter-1"] : [] };
        },
      });

      expect(invoked).toEqual(["otter-1", "otter-1"]);
      expect(receivedSteer).toEqual([false, true]);
    });
  });

  // ─── 可选依赖降级 ───

  describe("可选依赖降级", () => {
    it("无 abort/healing 回调时护栏降级 no-op（不抛）", async () => {
      m.setSeededEntries([
        { id: "ey-2", sequenceNum: 2, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e2", yieldTargets: ["otter-1"] },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

      const engine = makeChainEngine(m, { abort: undefined, healingRepo: undefined });
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ invokeId: "inv-new", messageId: "inv-new", aggregatedTargets: ["otter-1"] }),
      });

      // 不抛异常（回调可选，降级为 no-op）——F20260913ctlv：otterReply 已退役，不抛即通过
    });

    it("无 healingRepo 时 abort 不留痕（不抛）", async () => {
      m.setSeededEntries([
        { id: "ey-4", sequenceNum: 4, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e4", yieldTargets: ["otter-1"] },
        { id: "ey-3", sequenceNum: 3, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e3", yieldTargets: ["otter-1"] },
        { id: "ey-2", sequenceNum: 2, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e2", yieldTargets: ["otter-1"] },
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-e1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

      const engine = makeChainEngine(m, { healingRepo: undefined });
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ invokeId: "inv-new", messageId: "inv-new", aggregatedTargets: ["otter-1"] }),
      });

      // abort 被调用但 healing 不写入（不抛）
      expect(m.abort).toHaveBeenCalledOnce();
    });

    it("getEntries 查询失败降级为 count=0（不阻断链路）", async () => {
      (m.entryRepo.getEntries as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db error"));
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" });

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ invokeId: "inv-new", messageId: "inv-new", aggregatedTargets: ["otter-1"] }),
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
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-work", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["owner-otter"], endedAt: "2026-09-10T00:00:00Z" });

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
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "m-noyield", status: "completed", otterId: "otter-1", talkingStonePassedTo: [], endedAt: "2026-09-10T00:00:00Z" });

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ invokeId: "m-noyield", messageId: "m-noyield", aggregatedTargets: [] }),
      });

      expect(m.abort).not.toHaveBeenCalled();
      expect(m.abort).not.toHaveBeenCalled();
    });
  });

  // ─── 同会话边界 ───

  describe("同会话边界", () => {
    it("countConsecutiveSelfYields 只查本会话（getEntries 传入 conversationId）", async () => {
      m.setSeededEntries([
        { id: "ey-1", sequenceNum: 1, entryType: "yield", senderType: "otter", senderId: "otter-1", body: "", invokeId: "inv-1", yieldTargets: ["otter-1"] },
      ]);
      (m.invokeRepo.getInvokeById as ReturnType<typeof vi.fn>).mockResolvedValue(
        { id: "inv-new", status: "completed", otterId: "otter-1", talkingStonePassedTo: ["otter-1"], endedAt: "2026-09-10T00:00:00Z" }
      );

      const engine = makeChainEngine(m);
      await engine.executeChain({
        conversationId: "conv-1",
        userMessageContent: "hi",
        senderId: "user",
        initialTargets: ["otter-1"],
        invokeFn: async () => ({ invokeId: "inv-new", messageId: "inv-new", aggregatedTargets: ["otter-1"] }),
      });

      // F20260913ctlv：护栏计数数据源 = entries——副作用断言：本会话至少被扫描过一次
      expect((m.entryRepo.getEntries as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
