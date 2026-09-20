/**
 * F20260916b1ea ResumeInterruptedService 恢复编排测试（invoke 模型重建版，真 sqlite + stub 链引擎）。
 *
 * 验证：pending 消费 → CAS 认领 → 链引擎续跑（引导文案 + initialTargets=[otterId]）
 * → invoke 终态直读 done 流转；并发窗口跳过（entries 数据源）；participant 失效
 * exhausted 静默；链引擎抛错 failed + 失败提示；429 退避重试与耗尽；CAS 认领冲突
 * 跳过；成功零系统消息（静默裁决沿用 9/6）；healing 落账。
 * F20260917rscr：信号补扫已删除（9/17 重启风暴实证，修法排序③）——恢复只认队列。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteResumePendingRepository } from "@frameworks/db/conversation/sqlite-resume-pending-repository";
import { ResumeInterruptedService } from "@usecases/conversation/resume-interrupted-service";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

const T0 = "2026-01-01T00:00:00Z";

function otterFixture(id: string): Otter {
  return {
    id, name: `獭-${id}`, type: "big", status: "active",
    role: null, parentOtterId: null,
    createdAt: T0, dissolvedAt: null,
  };
}

function participantFixture(otterId: string, overrides: Partial<ConversationParticipant> = {}): ConversationParticipant {
  return {
    id: `p-${otterId}`, conversationId: "conv-1", otterId,
    status: "active",
    createdAt: T0, leftAt: null,
    ...overrides,
  };
}

/** 链引擎 stub：捕获调用参数，真实调用 invokeFn（模拟首 hop 点火），可配置行为 */
function stubChainEngine(behavior: { throwError?: Error } = {}) {
  const calls: Array<{
    conversationId: string;
    initialTargets: string[];
    userMessageContent: string;
    triggerMessageId?: string;
  }> = [];
  const engine = {
    executeChain: vi.fn(async (params: {
      conversationId: string;
      initialTargets: string[];
      userMessageContent: string;
      triggerMessageId?: string;
      invokeFn: (p: unknown) => Promise<unknown>;
    }) => {
      calls.push({
        conversationId: params.conversationId,
        initialTargets: params.initialTargets,
        userMessageContent: params.userMessageContent,
        triggerMessageId: params.triggerMessageId,
      });
      if (behavior.throwError) throw behavior.throwError;
      // 模拟链引擎首 hop：对每个 initialTarget 调 invokeFn。
      // 链吞错语义（allSettled 不上抛）——拒绝被 captureInvokeFn 捕获，
      // 由 settleResumedOutcome 的 invoke 终态直读判定（F4）。
      await Promise.allSettled(params.initialTargets.map(() => params.invokeFn({} as never)));
      return { otterReply: undefined };
    }),
    calls,
  };
  return engine as unknown as DispatchChainEngine & { calls: typeof calls };
}

/** healing repo stub：捕获 create */
function stubHealingRepo() {
  const created: unknown[] = [];
  const repo = {
    create: vi.fn(async (event: unknown) => { created.push(event); }),
    created,
  };
  return repo as unknown as HealingEventRepository & { created: unknown[] };
}

/** 多会话容错用：conv-2 中断现场（otter-small + pending invoke） */
async function seedConv2(
  db: Database.Database,
  convRepo: SqliteConversationRepository,
  otterRepo: SqliteOtterRepository,
): Promise<string> {
  const conv2: Conversation = {
    id: "conv-2", title: "测试对话2", status: "active", summary: null, pinned: false, workspaceDir: null,
    createdAt: T0, updatedAt: T0, completedAt: null, archivedAt: null,
  };
  await convRepo.create(conv2);
  await otterRepo.createOtter(otterFixture("otter-small"));
  await convRepo.createParticipant(participantFixture("otter-small", { id: "p-small", conversationId: "conv-2" }));
  const userEntry2 = crypto.randomUUID();
  const invokeId2 = crypto.randomUUID();
  db.prepare(`
    INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, invoke_id, yield_targets, status, sender_name, created_at, completed_at)
    VALUES (?, 'conv-2', 1, 'user', 'user', 'chen', '开工', NULL, '["otter-small"]', 'completed', '搭档', ?, ?)
  `).run(userEntry2, T0, T0);
  db.prepare(`
    INSERT INTO invokes (id, conversation_id, otter_id, status, trigger_entry_id, started_at)
    VALUES (?, 'conv-2', 'otter-small', 'running', ?, ?)
  `).run(invokeId2, userEntry2, T0);
  db.prepare(`
    INSERT INTO restart_pending_resumes (invoke_id, conversation_id, otter_id, trigger_entry_id, status, attempts, created_at)
    VALUES (?, 'conv-2', 'otter-small', ?, 'pending', 0, ?)
  `).run(invokeId2, userEntry2, T0);
  return invokeId2;
}

/** 测试夹具集合（harness 模式——describe 回调行数受 eslint max-lines-per-function 约束） */
interface Harness {
  db: Database.Database;
  convRepo: SqliteConversationRepository;
  otterRepo: SqliteOtterRepository;
  invokeRepo: SqliteInvokeRepository;
  entryRepo: SqliteEntryRepository;
  resumeRepo: SqliteResumePendingRepository;
  systemEntries: Array<{ conversationId: string; body: string }>;
  /** 中断现场播种：user entry + running invoke + pending 队列行，返回 invokeId */
  seedInterrupted(opts?: {
    otterId?: string;
    invokeId?: string;
    userEntryCreatedAt?: string;
    userYieldTargets?: string[] | null;
    withPending?: boolean;
  }): Promise<string>;
  queueStatus(invokeId: string): string | undefined;
  buildService(
    chain: DispatchChainEngine & { calls: unknown[] },
    opts?: {
      healingRepo?: ReturnType<typeof stubHealingRepo>;
      delayMs?: number;
      rateLimitBaseDelayMs?: number;
      invokeFn?: () => Promise<{ messageId: string }>;
    },
  ): ResumeInterruptedService;
}

function makeHarness(): Harness {
  const db = createTestDb();
  const convRepo = new SqliteConversationRepository(db, createTestLogger());
  const otterRepo = new SqliteOtterRepository(db);
  const invokeRepo = new SqliteInvokeRepository(db);
  const entryRepo = new SqliteEntryRepository(db);
  const resumeRepo = new SqliteResumePendingRepository(db);
  const systemEntries: Array<{ conversationId: string; body: string }> = [];
  const h: Harness = {
    db, convRepo, otterRepo, invokeRepo, entryRepo, resumeRepo, systemEntries,
    seedInterrupted: async (opts = {}) => {
      const otterId = opts.otterId ?? "otter-big";
      const invokeId = opts.invokeId ?? crypto.randomUUID();
      const userEntryId = crypto.randomUUID();
      const createdAt = opts.userEntryCreatedAt ?? T0;
      db.prepare(`
        INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, invoke_id, yield_targets, status, sender_name, created_at, completed_at)
        VALUES (?, 'conv-1', 1, 'user', 'user', 'chen', '开工', NULL, ?, 'completed', '搭档', ?, ?)
      `).run(userEntryId, opts.userYieldTargets === null ? null : JSON.stringify(opts.userYieldTargets ?? [otterId]), createdAt, createdAt);
      db.prepare(`
        INSERT INTO invokes (id, conversation_id, otter_id, status, trigger_entry_id, started_at)
        VALUES (?, 'conv-1', ?, 'running', ?, ?)
      `).run(invokeId, otterId, userEntryId, createdAt);
      if (opts.withPending !== false) {
        db.prepare(`
          INSERT INTO restart_pending_resumes (invoke_id, conversation_id, otter_id, trigger_entry_id, status, attempts, created_at)
          VALUES (?, 'conv-1', ?, ?, 'pending', 0, ?)
        `).run(invokeId, otterId, userEntryId, createdAt);
      }
      return invokeId;
    },
    queueStatus: (invokeId) => {
      const row = db.prepare("SELECT status FROM restart_pending_resumes WHERE invoke_id = ?").get(invokeId) as { status: string } | undefined;
      return row?.status;
    },
    buildService: (chain, opts = {}) => new ResumeInterruptedService({
      conversationRepo: convRepo,
      entryRepo,
      invokeRepo,
      resumePendingRepo: resumeRepo,
      dispatchChainEngine: chain,
      invokeFn: opts.invokeFn ?? (async () => ({ messageId: "new-invoke-1" })),
      sendSystemEntry: async (conversationId, body) => {
        systemEntries.push({ conversationId, body });
      },
      healingRepo: opts.healingRepo,
      logger: createTestLogger(),
      delayMs: opts.delayMs ?? 0,
      rateLimitBaseDelayMs: opts.rateLimitBaseDelayMs,
    }),
  };
  return h;
}

describe("ResumeInterruptedService（F20260916b1ea invoke 模型重建）", () => {
  let h: Harness;

  beforeEach(async () => {
    h = makeHarness();
    const conv: Conversation = {
      id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: T0, updatedAt: T0, completedAt: null, archivedAt: null,
    };
    await h.convRepo.create(conv);
    await h.otterRepo.createOtter(otterFixture("otter-big"));
    await h.convRepo.createParticipant(participantFixture("otter-big"));
  });

  afterEach(() => {
    h.db.close();
  });

  it("基础恢复：CAS 认领 → 链引擎续跑（引导文案 + initialTargets + triggerMessageId=中断 invoke）→ done，成功零系统消息", async () => {
    const invokeId = await h.seedInterrupted();
    const chain = stubChainEngine();

    await h.buildService(chain).resume();

    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]).toMatchObject({
      conversationId: "conv-1",
      initialTargets: ["otter-big"],
      triggerMessageId: invokeId,
    });
    expect(chain.calls[0]!.userMessageContent).toContain("[系统提醒] 服务重启导致你的发言中断");
    expect(chain.calls[0]!.userMessageContent).toContain("保留在对话中");
    // done 流转
    expect(h.queueStatus(invokeId)).toBe("done");
    // F20260906rsts 沿用：成功路径静默——零系统消息
    expect(h.systemEntries).toHaveLength(0);
  });

  it("獭已恢复（中断后有新 invoke）：跳过 + exhausted 静默（F20260917rscr 三点裁决③）", async () => {
    const invokeId = await h.seedInterrupted();
    // 中断时刻（队列行 created_at）之后，同会话同獭已有新 invoke——用户手动接上/cron 重触发
    const now = new Date().toISOString();
    h.db.prepare(`
      INSERT INTO invokes (id, conversation_id, otter_id, status, trigger_entry_id, talking_stone_passed_to, started_at, tool_call_count)
      VALUES (?, 'conv-1', 'otter-big', 'running', NULL, NULL, ?, 0)
    `).run(crypto.randomUUID(), now);

    const chain = stubChainEngine();
    await h.buildService(chain).resume();

    expect(chain.calls).toHaveLength(0);
    expect(h.queueStatus(invokeId)).toBe("exhausted");
    // 静默——獭已在跑，恢复目的已达成，不发「请手动重试」干扰
    expect(h.systemEntries).toHaveLength(0);
  });

  it("獭未恢复（中断后无新 invoke）：正常触发恢复", async () => {
    await h.seedInterrupted();
    const chain = stubChainEngine();
    await h.buildService(chain).resume();

    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]).toMatchObject({ conversationId: "conv-1", initialTargets: ["otter-big"] });
  });

  it("participant 已失效：CAS 认领后 exhausted 静默，不触发链引擎", async () => {
    const invokeId = await h.seedInterrupted();
    await h.convRepo.markParticipantLeft("conv-1", "otter-big");

    const chain = stubChainEngine();
    await h.buildService(chain).resume();

    expect(chain.calls).toHaveLength(0);
    expect(h.queueStatus(invokeId)).toBe("exhausted");
    // 静默：无系统消息
    expect(h.systemEntries).toHaveLength(0);
  });

  it("链引擎抛不可重试错误：failed + 失败提示（可手动重试）", async () => {
    const invokeId = await h.seedInterrupted();
    const chain = stubChainEngine({ throwError: new Error("chain exploded") });

    await h.buildService(chain).resume();

    expect(h.queueStatus(invokeId)).toBe("failed");
    expect(h.systemEntries.some(e => e.body.includes("恢复过程中 invoke 失败"))).toBe(true);
  });

  it("429 限流：指数退避重试后成功", async () => {
    const invokeId = await h.seedInterrupted();
    let invokeCalls = 0;
    const chain = stubChainEngine();
    // invokeFn 前两次抛 429，第三次成功
    const service = h.buildService(chain, {
      rateLimitBaseDelayMs: 1,
      invokeFn: async () => {
        invokeCalls++;
        if (invokeCalls <= 2) throw new Error("429 rate limit exceeded");
        return { messageId: "new-invoke-1" };
      },
    });

    await service.resume();

    expect(invokeCalls).toBe(3);
    expect(h.queueStatus(invokeId)).toBe("done");
    expect(chain.calls).toHaveLength(3);
  });

  it("429 重试耗尽：标 failed + 失败提示", async () => {
    const invokeId = await h.seedInterrupted();
    const chain = stubChainEngine();
    const service = h.buildService(chain, {
      rateLimitBaseDelayMs: 1,
      invokeFn: async () => {
        throw new Error("429 rate limit exceeded");
      },
    });

    await service.resume();

    // 1 首次 + 3 次重试 = 4 次调用
    expect(chain.calls).toHaveLength(4);
    expect(h.queueStatus(invokeId)).toBe("failed");
    expect(h.systemEntries.some(e => e.body.includes("恢复过程中 invoke 失败"))).toBe(true);
  });

  it("CAS 认领冲突（status 非 pending）：跳过不恢复", async () => {
    const invokeId = await h.seedInterrupted();
    // 模拟并发窗口已被认领：attempts 先自增到上限外的某状态——直接置 done
    h.db.prepare("UPDATE restart_pending_resumes SET status = 'done' WHERE invoke_id = ?").run(invokeId);

    const chain = stubChainEngine();
    await h.buildService(chain).resume();

    expect(chain.calls).toHaveLength(0);
    expect(h.queueStatus(invokeId)).toBe("done");
  });

  it("attempts 达上限（跨重启无限重试守卫，S1 修复）：exhausted 闭环不再恢复", async () => {
    const invokeId = await h.seedInterrupted();
    // 模拟恢复中崩溃五次：attempts 已自增到上限（MAX_RESUME_ATTEMPTS=5），status 仍 pending
    h.db.prepare("UPDATE restart_pending_resumes SET attempts = 5 WHERE invoke_id = ?").run(invokeId);

    const chain = stubChainEngine();
    await h.buildService(chain).resume();

    expect(chain.calls).toHaveLength(0);
    expect(h.queueStatus(invokeId)).toBe("exhausted");
  });

  it("healing 落账：服务重启事件按中断数分级落账", async () => {
    await h.seedInterrupted();
    await h.seedInterrupted({ otterId: "otter-big", invokeId: crypto.randomUUID() });
    const healing = stubHealingRepo();
    const chain = stubChainEngine();

    await h.buildService(chain, { healingRepo: healing }).resume();

    expect(healing.created).toHaveLength(1);
    const event = healing.created[0] as { description: string; severity: string };
    expect(event.description).toContain("2 条 invoke 中断");
    expect(event.severity).toBe("medium");
  });

  it("invokeFn 拒绝非可重试错误：failed + 失败提示", async () => {
    const invokeId = await h.seedInterrupted();
    // invokeFn 直接被链引擎调用——stub 链引擎里走 captureInvokeFn。
    // 这里让链引擎内部调 invokeFn 并抛错。
    const engine = {
      executeChain: vi.fn(async (params: { invokeFn: (p: unknown) => Promise<unknown> }) => {
        await params.invokeFn({} as never);
        return { otterReply: undefined };
      }),
      calls: [],
    } as unknown as DispatchChainEngine & { calls: unknown[] };
    const service = h.buildService(engine, {
      invokeFn: async () => {
        throw new Error("model exploded");
      },
    });

    await service.resume();

    expect(h.queueStatus(invokeId)).toBe("failed");
    expect(h.systemEntries.some(e => e.body.includes("恢复过程中 invoke 失败"))).toBe(true);
  });

  it("invokeFn 成功但新 invoke 终态 failed：done 判定直读 invoke 行 → failed", async () => {
    const invokeId = await h.seedInterrupted();
    const chain = stubChainEngine();
    const newInvokeId = crypto.randomUUID();
    // invokeFn 正常返回（invokeId），但 invoke 行已是 failed 终态
    h.db.prepare(`
      INSERT INTO invokes (id, conversation_id, otter_id, status, started_at, ended_at)
      VALUES (?, 'conv-1', 'otter-big', 'failed', ?, ?)
    `).run(newInvokeId, T0, T0);

    const service = h.buildService(chain, {
      invokeFn: async () => ({ messageId: newInvokeId }),
    });

    await service.resume();

    expect(h.queueStatus(invokeId)).toBe("failed");
    expect(h.systemEntries.some(e => e.body.includes("恢复过程中 invoke 失败"))).toBe(true);
  });

  it("多会话并行容错：一个会话失败不阻塞其余", async () => {
    const invokeId1 = await h.seedInterrupted();
    const invokeId2 = await seedConv2(h.db, h.convRepo, h.otterRepo);

    // conv-1 的链调用抛错，conv-2 正常
    const calls: string[] = [];
    const engine = {
      executeChain: vi.fn(async (params: { conversationId: string }) => {
        calls.push(params.conversationId);
        if (params.conversationId === "conv-1") throw new Error("chain exploded for conv-1");
        return { otterReply: undefined };
      }),
    } as unknown as DispatchChainEngine & { calls: unknown[] };

    await h.buildService(engine).resume();

    expect(h.queueStatus(invokeId1)).toBe("failed");
    expect(h.queueStatus(invokeId2)).toBe("done");
  });
});
