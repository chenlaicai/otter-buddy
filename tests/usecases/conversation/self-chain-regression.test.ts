import { describe, it, expect, vi } from "vitest";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";
import type { Message } from "@entities/conversation/message";

/**
 * F20260904schf（issue #792）：信号自链循环事故形态回归测试。
 *
 * 事故（2026-09-04 02:54-02:59）：检视獭解散后，其积压信号（tsp=[大獭]）与大獭产出消息
 * 共栖同一 open turn（长 invoke 期间 ensureActiveTurn 复用）→ tryCloseTurn 返回 turn 级
 * tsp 并集（含 [大獭]）→ 链引擎把并集当行级 yield 出处回填 → chainSource[大獭]=大獭自己的
 * 产出消息 → 下一 hop 自点火，同批信号反复点火 2-4 轮，INSERT OR REPLACE 覆盖抹平致账本自盲。
 *
 * 修复：链引擎出处取数改行级——读产出消息自身的 talkingStonePassedTo 终值
 * （completeMessage 先落库后关 turn，行级值因果局部、无 turn 共存窗），
 * aggregatedTargets（turn 级并集）不再被消费。
 */

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

function makeEnv(messageRows: Record<string, Message>, opts?: { getMessageByIdError?: Error }) {
  const attempts: Array<{ messageId: string; target: string; status: string; note?: string }> = [];
  const dispatchAttemptRepo = {
    recordStart: (a: { messageId: string; targetOtterId: string }) => {
      attempts.push({ messageId: a.messageId, target: a.targetOtterId, status: "in_progress" });
    },
    recordFinish: (messageId: string, target: string, status: string) => {
      const row = [...attempts].reverse().find(x => x.messageId === messageId && x.target === target && x.status === "in_progress");
      if (row) row.status = status;
    },
    backfillLegacyAttempted: () => 0,
    countPendingSignals: () => 0,
    countPendingForTarget: () => ({ total: 0, halt: 0 }),
    listPendingSignals: () => [],
    markStaleInProgressFailed: () => 0,
    shouldThrottle: () => false,
    allAnchorAttemptsSettled: () => true,
    failAllInProgressForOtter: () => 0,
    appendNote: (messageId: string, target: string, note: string) => {
      const row = attempts.find(x => x.messageId === messageId && x.target === target);
      if (row) row.note = ((row as { note?: string }).note ?? "") + note;
    },
    listAttemptsForConversation: () => [],
  } as unknown as DispatchAttemptRepo;

  const getMessageById = vi.fn(async (id: string) => {
    if (opts?.getMessageByIdError) throw opts.getMessageByIdError;
    return messageRows[id] ?? null;
  });

  const makeTurn = (overrides: Record<string, unknown> = {}) => ({
    id: "turn-1", conversationId: "conv-1", turnNumber: 5, status: "closed", createdAt: "", closedAt: null, ...overrides,
  });

  const conversationRepo = {
    getActiveParticipants: vi.fn().mockResolvedValue([]),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    getMaxTurnNumber: vi.fn().mockResolvedValue(0),
    getTurnById: vi.fn(async () => makeTurn()),
    getMessageById,
    updateLastReadTurnNumber: vi.fn().mockResolvedValue(undefined),
    updateLastActiveTurnNumber: vi.fn().mockResolvedValue(undefined),
    updateLastReadSeq: vi.fn().mockResolvedValue(undefined),
    getLastMessageBySender: vi.fn().mockResolvedValue(null),
  } as unknown as ConversationRepository;

  const queryMessage = { getMessageById, getLastMessageBySender: vi.fn().mockResolvedValue(null) } as unknown as QueryMessage;
  const queryOtter = { getById: vi.fn().mockResolvedValue(null) } as unknown as QueryOtter;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  const engine = new DispatchChainEngine({
    conversationRepo, queryMessage, queryOtter, logger,
    dispatchAttemptRepo, maxChainDepth: 10,
  });

  return { attempts, engine, getMessageById, logger };
}

describe("F20260904schf：信号自链循环事故形态回归（#792）", () => {

  it("事故回放：产出消息行级 tsp 异常含 sender 自己时，自指守卫拦截，链一轮终止", async () => {
    // 领域不变量：发言石传给别人，行级 tsp 不应含 sender 自己。此处模拟上游异常产出自指行
    // （历史脏数据/工具层 bug）——链引擎纵深防御：不回到自己名下，不二跳自燃。
    const bigOtter = "otter-big";
    const { engine } = makeEnv({
      "m-out": makeMsg({ id: "m-out", senderId: bigOtter, talkingStonePassedTo: [bigOtter] }),
    });
    const invoked: string[] = [];

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: [bigOtter],
      triggerMessageId: "m-user",
      invokeFn: async () => {
        invoked.push(bigOtter);
        return { messageId: "m-out" };
      },
    });

    expect(invoked).toEqual([bigOtter]);
  });

  it("事故回放：turn 共栖污染（aggregatedTargets 含自己）不回填脏账——行级 tsp 为准", async () => {
    // invoke 返回的 aggregatedTargets 是 turn 级并集，被共栖信号污染（含 worker 自己）；
    // 行级 tsp 干净（yield 给 owner）——修复后脏并集不再被消费。
    const { attempts, engine } = makeEnv({
      "m-out": makeMsg({ id: "m-out", senderId: "otter-worker", talkingStonePassedTo: ["owner-otter"] }),
    });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      triggerMessageId: "m-user",
      invokeFn: async () => ({
        messageId: "m-out",
        aggregatedTargets: ["otter-worker", "owner-otter"], // turn 级并集：含共栖污染（自己）
      }),
    });

    // hop2 记账：m-out 记在 owner-otter 名下（行级事实）；worker 名下无自指脏账
    const workerRow = attempts.find(a => a.messageId === "m-out" && a.target === "otter-worker");
    expect(workerRow).toBeUndefined();
    const ownerRow = attempts.find(a => a.messageId === "m-out" && a.target === "owner-otter");
    expect(ownerRow).toBeDefined();
    expect(ownerRow!.status).toBe("completed");
  });

  it("并行错记族：先完成者的行级 yield 不被空聚合吞掉（closed:false 场景修复）", async () => {
    // A、B 并行同 hop：旧行为下先完成者拿空聚合 → yield 丢失 → 假 pending → 补扫重复点火；
    // 行级化后 A 读自己消息的 tsp=[C]，正常记账路由。
    const { attempts, engine } = makeEnv({
      "m-a": makeMsg({ id: "m-a", senderId: "otter-a", talkingStonePassedTo: ["otter-c"] }),
      "m-b": makeMsg({ id: "m-b", senderId: "otter-b", talkingStonePassedTo: [] }),
      "m-c": makeMsg({ id: "m-c", senderId: "otter-c", talkingStonePassedTo: [] }),
    });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-a", "otter-b"],
      invokeFn: async ({ otterId }) => {
        if (otterId === "otter-a") return { messageId: "m-a", aggregatedTargets: [] }; // 先完成：空聚合（旧 bug 场景）
        if (otterId === "otter-b") return { messageId: "m-b", aggregatedTargets: ["otter-a", "otter-c"] }; // 后完成：全 turn 并集
        return { messageId: "m-c", aggregatedTargets: [] };
      },
    });

    // A 的 yield 目标 C 被正确记账与路由（行级说真话）
    const cRow = attempts.find(a => a.messageId === "m-a" && a.target === "otter-c");
    expect(cRow).toBeDefined();
    expect(cRow!.status).toBe("completed");
  });

  it("并行错记族：后完成者的全 turn 并集不外溢——B 无行级 yield 则零路由", async () => {
    // B 的并集含 [A的yield, B的yield]，但 B 自己的行级 tsp 为空——
    // 旧行为会把 A 的 yield 记到 B 产出名下（错记），行级化后 B 零外溢。
    const { engine } = makeEnv({
      "m-a": makeMsg({ id: "m-a", senderId: "otter-a", talkingStonePassedTo: ["otter-c"] }),
      "m-b": makeMsg({ id: "m-b", senderId: "otter-b", talkingStonePassedTo: [] }),
      "m-c": makeMsg({ id: "m-c", senderId: "otter-c", talkingStonePassedTo: [] }),
    });
    const invocations: string[] = [];

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-a", "otter-b"],
      invokeFn: async ({ otterId }) => {
        invocations.push(otterId);
        if (otterId === "otter-a") return { messageId: "m-a", aggregatedTargets: ["otter-b", "otter-c"] };
        return { messageId: "m-b", aggregatedTargets: [] };
      },
    });

    // hop2 只唤醒 C（来自 A 的行级 yield）；C 恰一次
    expect(invocations).toEqual(["otter-a", "otter-b", "otter-c"]);
  });

  it("正当场景保全：A、B 同 hop 都 yield C，C 两条触发消息各记一条（hopf 多源记账不回退）", async () => {
    const { attempts, engine } = makeEnv({
      "m-a": makeMsg({ id: "m-a", senderId: "otter-a", talkingStonePassedTo: ["otter-c"] }),
      "m-b": makeMsg({ id: "m-b", senderId: "otter-b", talkingStonePassedTo: ["otter-c"] }),
      "m-c": makeMsg({ id: "m-c", senderId: "otter-c", talkingStonePassedTo: [] }),
    });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-a", "otter-b"],
      invokeFn: async ({ otterId }) => {
        if (otterId === "otter-a") return { messageId: "m-a", aggregatedTargets: ["otter-c"] };
        if (otterId === "otter-b") return { messageId: "m-b", aggregatedTargets: ["otter-c"] };
        return { messageId: "m-c", aggregatedTargets: [] };
      },
    });

    const forC = attempts.filter(a => a.target === "otter-c");
    expect(forC.map(a => a.messageId).sort()).toEqual(["m-a", "m-b"]);
    expect(forC.every(a => a.status === "completed")).toBe(true);
  });

  it("正当场景保全：#474 小獭 yield 回任务属主（行级 tsp=属主，属主被唤醒且不被滤）", async () => {
    const { engine } = makeEnv({
      "m-work": makeMsg({ id: "m-work", senderId: "otter-worker", talkingStonePassedTo: ["owner-otter"] }),
      "m-owner": makeMsg({ id: "m-owner", senderId: "owner-otter", talkingStonePassedTo: [] }),
    });
    const invoked: string[] = [];

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "owner-otter",
      initialTargets: ["otter-worker"],
      invokeFn: async ({ otterId }) => {
        invoked.push(otterId);
        return { messageId: otterId === "otter-worker" ? "m-work" : "m-owner", aggregatedTargets: [] };
      },
    });

    expect(invoked).toEqual(["otter-worker", "owner-otter"]);
  });

  it("行级查库失败：出处视为空不再路由，主流程不抛（硬约束 1）", async () => {
    const { engine, logger } = makeEnv({}, { getMessageByIdError: new Error("db glitch") });
    const invocations: string[] = [];

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      invokeFn: async ({ otterId }) => {
        invocations.push(otterId);
        return { messageId: "m-out", aggregatedTargets: ["otter-next"] };
      },
    });

    // 查库失败 → 行级出处为空 → 不路由；外层 try 吞掉 recordAttemptSettle 的异常
    expect(invocations).toEqual(["otter-worker"]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("F20260904ldgr #798 发现2：降级槽位账面留痕——appendNote 标记出处降级，status 不变", async () => {
    const { engine, attempts, logger } = makeEnv({}, { getMessageByIdError: new Error("db glitch") });

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      // triggerMessageId 必传：首 hop 记账依赖它（无它 = S1 零侵入跳过，无行可标）
      triggerMessageId: "m-user",
      invokeFn: async () => ({ messageId: "m-out", aggregatedTargets: ["otter-next"] }),
    });

    // 账面：槽位（触发消息 m-user 名下，非产出消息）仍 completed，但 note 含降级标记
    const row = attempts.find(a => a.messageId === "m-user" && a.target === "otter-worker");
    expect(row).toBeDefined();
    expect(row!.status).toBe("completed");
    expect((row as { note?: string }).note ?? "").toContain("出处降级");
    // 日志兜底仍在（双通道）：查库失败 warn 至少一次（状态断言，不断言参数绑定）
    const warnMessages = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]));
    expect(warnMessages.some(m => m.includes("查库失败"))).toBe(true);
  });

  it("F20260904ldgr #798 发现1：17 源 fan-in 触发截尾 warn，保留最新 16 源；16 源以内零截尾", async () => {
    // 单 hop 并行 17 个 otter 都 yield 给 otter-c：第 1 条（最早）被截掉，2..17 保留
    const messageRows: Record<string, Message> = {};
    for (let i = 1; i <= 17; i++) {
      messageRows[`m-src-${i}`] = makeMsg({
        id: `m-src-${i}`, senderId: `otter-s-${i}`,
        talkingStonePassedTo: ["otter-c"],
      });
    }
    const { engine, logger } = makeEnv(messageRows);
    const invocations: string[] = [];

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: Array.from({ length: 17 }, (_, i) => `otter-s-${i + 1}`),
      invokeFn: async ({ otterId }) => {
        invocations.push(otterId);
        const idx = invocations.length;
        return { messageId: `m-src-${idx}`, aggregatedTargets: ["otter-c"] };
      },
    });

    const truncWarns = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("截尾"),
    );
    expect(truncWarns.length).toBe(1);
    expect(truncWarns[0][1]).toMatchObject({ next: "otter-c", dropped: 1 });
  });

  it("F20260904ldgr #798 发现1：16 源 fan-in 在上限内不截尾（现状兼容）", async () => {
    const messageRows: Record<string, Message> = {};
    for (let i = 1; i <= 16; i++) {
      messageRows[`m-k-${i}`] = makeMsg({ id: `m-k-${i}`, senderId: `otter-k-${i}`, talkingStonePassedTo: ["otter-c"] });
    }
    const { engine, logger } = makeEnv(messageRows);
    const invocations: string[] = [];

    await engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: Array.from({ length: 16 }, (_, i) => `otter-k-${i + 1}`),
      invokeFn: async ({ otterId }) => {
        invocations.push(otterId);
        const idx = invocations.length;
        return { messageId: `m-k-${idx}`, aggregatedTargets: ["otter-c"] };
      },
    });

    const truncWarns = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("截尾"),
    );
    expect(truncWarns.length).toBe(0);
  });
});
