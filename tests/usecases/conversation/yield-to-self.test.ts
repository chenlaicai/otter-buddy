/**
 * F20260907ylfs ②：yield-to-self 合法化（P3a 批次 2）集成测试。
 *
 * 语义：獭可以 yield 给自己 = 任务锚点入箱（「任务未完成，下轮继续」），
 * 消化路径唯一 = 护栏门控的链续跑（resolveHopOutcomes：计数 <5 放行 self 进下一跳；
 * =3 附 steer 警示；≥5 拒入 + abort + healing 留痕——③ 梯度护栏 F20260907grdr）。
 *
 * 设计锚点：p3a-design-full.md「② yield-to-self 合法化」节 + 快审处置记录。
 * 顺序依赖（快审 delta 重点）：护栏决策提前在 executeOneHop 内单点计算（resolveHopOutcomes），
 * recordAttemptSettle（chainSource 回填）与 processHopResults（nextTargets 路由）共享同一结果。
 */
import { describe, it, expect, vi } from "vitest";
import { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { QueryMessage } from "@usecases/conversation/query-message";
import type { QueryOtter } from "@usecases/otter/query-otter";
import type { Logger } from "@usecases/ports/logger";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";
import type { DispatchAttemptRepo } from "@entities/conversation/dispatch-attempt";
import type { Message } from "@entities/conversation/message";

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

function makeEnv(opts?: { ledger?: boolean }) {
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
    abortUnattemptedOutgoingForOtter: () => 0,
    abortUnattemptedIncomingForOtter: () => 0,
    appendNote: (messageId: string, target: string, note: string) => {
      const row = attempts.find(x => x.messageId === messageId && x.target === target);
      if (row) row.note = ((row as { note?: string }).note ?? "") + note;
    },
    listAttemptsForConversation: () => [],
    getAttempt: () => null,
  } as unknown as DispatchAttemptRepo;

  const abort = vi.fn();
  const healingCreate = vi.fn().mockResolvedValue(undefined);

  /** 动态消息表（生产时序模拟：completeMessage 先落库后关 turn）——self 链每 hop 产出自己的消息 */
  const messageTable: Message[] = [];
  const getMessageById = vi.fn(async (id: string) => messageTable.find(m => m.id === id) ?? null);
  const getMessages = vi.fn(async (_convId: string, o?: { limit?: number; before?: string }) => {
    let list = messageTable;
    if (o?.before) {
      const idx = messageTable.findIndex(m => m.id === o.before);
      if (idx >= 0) list = list.slice(0, idx);
    }
    return [...list].reverse();
  });

  const conversationRepo = {
    getActiveParticipants: vi.fn().mockResolvedValue([]),
    getUnreadMessages: vi.fn().mockResolvedValue([]),
    getMaxTurnNumber: vi.fn().mockResolvedValue(0),
    getTurnById: vi.fn(async () => ({ id: "turn-1", conversationId: "conv-1", turnNumber: 5, status: "closed", createdAt: "", closedAt: null })),
    getMessageById,
    getMessages,
    updateLastReadSeq: vi.fn(),
    updateLastActiveTurnNumber: vi.fn().mockResolvedValue(undefined),
    getLastMessageBySender: vi.fn().mockResolvedValue(null),
  } as unknown as ConversationRepository;

  const queryMessage = { getMessageById, getLastMessageBySender: vi.fn().mockResolvedValue(null) } as unknown as QueryMessage;
  const queryOtter = { getById: vi.fn().mockResolvedValue(null) } as unknown as QueryOtter;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  const engine = new DispatchChainEngine({
    conversationRepo, queryMessage, queryOtter, logger,
    ...(opts?.ledger ? { dispatchAttemptRepo } : {}),
    maxChainDepth: 10,
    abort,
    healingRepo: { create: healingCreate } as never,
  });

  return { engine, attempts, invoked: [] as string[], messageTable, abort, healingCreate, getMessageById, getMessages };
}

describe("F20260907ylfs ②：yield-to-self 合法化（护栏门控消化）", () => {
  it("合法 self-yield：护栏计数 0 → 放行 self 进 nextTargets，链续跑即消化（无消息表时计数降级 0）", async () => {
    const env = makeEnv();
    let hop = 0;
    await env.engine.executeChain({
      conversationId: "conv-1", userMessageContent: "任务未完，下轮继续", senderId: "user",
      initialTargets: ["otter-worker"],
      invokeFn: async ({ otterId }) => {
        env.invoked.push(otterId);
        hop++;
        const produced = makeMsg({
          id: `m-hop${hop}`, sequenceNum: hop, senderId: "otter-worker",
          // hop1 self-yield（锚点入箱）；hop2 无 yield 收链
          talkingStonePassedTo: hop === 1 ? ["otter-worker"] : [],
        });
        env.messageTable.push(produced);
        return { messageId: produced.id };
      },
    });

    // self 不再被滤除：hop2 继续唤醒 otter-worker（链续跑即消化）
    expect(env.invoked).toEqual(["otter-worker", "otter-worker"]);
    expect(env.abort).not.toHaveBeenCalled();
  });

  it("护栏放行的 self hop 记 chainSource（自→自）：下轮起跑对产出消息销账，账面不说谎", async () => {
    const env = makeEnv({ ledger: true });
    let hop = 0;
    await env.engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      triggerMessageId: "m-user",
      invokeFn: async ({ otterId }) => {
        env.invoked.push(otterId);
        hop++;
        const produced = makeMsg({
          id: `m-hop${hop}`, sequenceNum: hop, senderId: "otter-worker",
          talkingStonePassedTo: hop === 1 ? ["otter-worker"] : [],
        });
        env.messageTable.push(produced);
        return { messageId: produced.id };
      },
    });

    // hop1: (m-user, otter-worker) completed；
    // hop2（self 续跑）: 起跑 (m-hop1, otter-worker) → completed——自→自消费义务逐条销账
    expect(env.invoked).toEqual(["otter-worker", "otter-worker"]);
    const hop2Start = env.attempts.find(a => a.messageId === "m-hop1" && a.target === "otter-worker");
    expect(hop2Start).toBeDefined();
    expect(hop2Start!.status).toBe("completed");
  });

  it("护栏拒绝（计数≥5）：self 不进链不记账 + abort + healing 留痕，链停（端到端真实计数）", async () => {
    const env = makeEnv({ ledger: true });
    let hop = 0;
    await env.engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      triggerMessageId: "m-user",
      invokeFn: async ({ otterId }) => {
        env.invoked.push(otterId);
        hop++;
        const produced = makeMsg({
          id: `m-hop${hop}`, sequenceNum: hop, senderId: "otter-worker",
          talkingStonePassedTo: ["otter-worker"], // 每跳都 self-yield（病态自链）
        });
        env.messageTable.push(produced);
        return { messageId: produced.id };
      },
    });

    // 端到端：hop1..hop5 均被唤醒（计数 total 1..5），hop5 total=5 ≥ abort 阈值 → 链停
    expect(env.invoked).toHaveLength(5);
    // abort + healing 留痕
    expect(env.abort).toHaveBeenCalledOnce();
    expect(env.healingCreate).toHaveBeenCalledOnce();
    const healingArg = env.healingCreate.mock.calls[0][0] as { description: string };
    expect(healingArg.description).toContain("5 次");
    // 拒入的 self hop 不记账：hop5 的产出 m-hop5 不得回填 chainSource → 无 (m-hop5, otter-worker) 起跑行
    const rejectedLedger = env.attempts.find(a => a.messageId === "m-hop5");
    expect(rejectedLedger).toBeUndefined();
    // 前 4 跳的自→自记账完好：m-hop1..m-hop4 各有一条 completed（下轮起跑销账后完成）
    for (let i = 1; i <= 4; i++) {
      const row = env.attempts.find(a => a.messageId === `m-hop${i}` && a.target === "otter-worker");
      expect(row).toBeDefined();
      expect(row!.status).toBe("completed");
    }
  });

  it("护栏拒入后 chainSource 不回填——账面无假 pending（拒入 hop 的产出消息无消费义务）", async () => {
    const env = makeEnv({ ledger: true });
    let hop = 0;
    await env.engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      triggerMessageId: "m-user",
      invokeFn: async ({ otterId }) => {
        env.invoked.push(otterId);
        hop++;
        const produced = makeMsg({
          id: `m-hop${hop}`, sequenceNum: hop, senderId: "otter-worker",
          talkingStonePassedTo: ["otter-worker"],
        });
        env.messageTable.push(produced);
        return { messageId: produced.id };
      },
    });

    // 拒入 hop（m-hop5）不得作为任何 target 的触发源回填——全部 attempts 里 m-hop5 只可能
    // 出现在「被 abort 前的 settle completed」（它是 hop5 自身产出，settled），无起跑行
    const hop5Rows = env.attempts.filter(a => a.messageId === "m-hop5");
    expect(hop5Rows).toHaveLength(0); // 拒入：既无起跑也无续跑销账
  });

  it("混合链：worker self-yield 与大獭并行目标共存——护栏只门控 self，其他目标透明放行", async () => {
    const env = makeEnv();
    let hop = 0;
    await env.engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      invokeFn: async ({ otterId }) => {
        env.invoked.push(otterId);
        if (otterId === "otter-worker") {
          hop++;
          const produced = makeMsg({
            id: `m-work-${hop}`, sequenceNum: hop, senderId: "otter-worker",
            // 混合：self（锚点入箱）+ 大獭（交棒）
            talkingStonePassedTo: hop === 1 ? ["otter-worker", "otter-big"] : [],
          });
          env.messageTable.push(produced);
          return { messageId: produced.id };
        }
        // 大獭 hop：无 yield 收链
        const bigMsg = makeMsg({ id: "m-big", sequenceNum: 90, senderId: "otter-big", talkingStonePassedTo: [] });
        env.messageTable.push(bigMsg);
        return { messageId: bigMsg.id };
      },
    });

    // hop2 = worker（self 续跑）+ big（交棒）并行唤醒；worker hop2 无 yield、big 无 yield → 链收
    expect(env.invoked).toContain("otter-big");
    expect(env.invoked.filter(id => id === "otter-worker")).toHaveLength(2);
  });

  it("steer 警示注入混合链：hop2 的多个目标都收到前置注入（含 self 续跑者）", async () => {
    const env = makeEnv();
    const receivedSteer: Record<string, boolean> = {};
    let workerHop = 0;
    await env.engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      invokeFn: async ({ otterId, userMessageContent }) => {
        // seed：2 条 previous self-yield（worker 名下）→ 本 hop total=3 → steer 生成 → 注入 hop2
        env.messageTable.push(
          makeMsg({ id: "seed-1", sequenceNum: 1, senderId: "otter-worker", talkingStonePassedTo: ["otter-worker"] }),
          makeMsg({ id: "seed-2", sequenceNum: 2, senderId: "otter-worker", talkingStonePassedTo: ["otter-worker"] }),
        );
        receivedSteer[`${otterId}#${env.invoked.length}`] = userMessageContent.includes("连续 3 次 self-yield");
        env.invoked.push(otterId);
        if (otterId === "otter-worker") {
          workerHop++;
          const produced = makeMsg({
            id: `m-work-${workerHop}`, sequenceNum: 10 + workerHop, senderId: "otter-worker",
            talkingStonePassedTo: workerHop === 1 ? ["otter-worker", "otter-big"] : [],
          });
          env.messageTable.push(produced);
          return { messageId: produced.id };
        }
        const bigMsg = makeMsg({ id: "m-big", sequenceNum: 90, senderId: "otter-big", talkingStonePassedTo: [] });
        env.messageTable.push(bigMsg);
        return { messageId: bigMsg.id };
      },
    });

    // hop1 无注入；hop2 的 self 续跑者与大獭都收到 steer 注入（警示面向整 hop，非仅 self）
    expect(receivedSteer["otter-worker#0"]).toBe(false);
    expect(receivedSteer["otter-worker#1"]).toBe(true);
    expect(receivedSteer["otter-big#2"]).toBe(true);
  });

  it("计数跨 hop 真实累计：第 3 跳生成 steer（前置注入第 4 跳），第 5 跳拒入链停（真实端到端）", async () => {
    const env = makeEnv();
    const receivedSteer: boolean[] = [];
    let hop = 0;
    await env.engine.executeChain({
      conversationId: "conv-1", userMessageContent: "hi", senderId: "user",
      initialTargets: ["otter-worker"],
      invokeFn: async ({ otterId, userMessageContent }) => {
        env.invoked.push(otterId);
        hop++;
        receivedSteer.push(userMessageContent.includes("连续 3 次 self-yield"));
        const produced = makeMsg({
          id: `m-hop${hop}`, sequenceNum: hop, senderId: "otter-worker",
          talkingStonePassedTo: ["otter-worker"],
        });
        env.messageTable.push(produced);
        return { messageId: produced.id };
      },
    });

    // hop1 total=1 放行；hop2 total=2 放行；hop3 total=3 → steer 生成注入 hop4；hop4 total=4；
    // hop5 total=5 → abort。注入只在 hop4 出现一次。
    expect(env.invoked).toHaveLength(5);
    expect(receivedSteer).toEqual([false, false, false, true, false]);
    expect(env.abort).toHaveBeenCalledOnce();
  });
});
