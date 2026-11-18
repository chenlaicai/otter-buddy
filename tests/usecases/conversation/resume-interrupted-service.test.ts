/**
 * ResumeInterruptedService 恢复编排测试（invoke 模型重建版，真 sqlite + stub 链引擎）。
 *
 * 验证：pending 消费 → CAS 认领 → 链引擎续跑（引导文案 + initialTargets=[otterId]）
 * → invoke 终态直读 done 流转；并发窗口跳过（entries 数据源）；participant 失效
 * exhausted 静默；链引擎抛错 failed + 失败提示；429 退避重试与耗尽；CAS 认领冲突
 * 跳过；成功零系统消息（静默裁决沿用 9/6）；healing 落账。
 * 信号补扫已删除（9/17 重启风暴实证，修法排序③）——恢复只认队列。
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
    color: null,
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
    id: "conv-2", title: "测试对话2", status: "active", summary: null, pinned: false, kind: "normal", workspaceDir: null,
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
    restricted?: boolean;
  }): Promise<string>;
  queueStatus(invokeId: string): string | undefined;
  buildService(
    chain: DispatchChainEngine & { calls: unknown[] },
    opts?: {
      healingRepo?: ReturnType<typeof stubHealingRepo>;
      delayMs?: number;
      rateLimitBaseDelayMs?: number;
      invokeFn?: () => Promise<{ messageId: string }>;
      actionLedger?: { listByInvoke(invokeId: string, limit?: number): Promise<import("@entities/execution/action-record").ActionRecord[]> };
      remoteActions?: { listByConversation(conversationId: string, limit?: number): Promise<import("@entities/execution/remote-action-request").RemoteActionRequest[]> };
      bootEpoch?: number;
      pid?: number;
      isPidAlive?: (pid: number) => boolean;
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
      // #906：entries (conversation_id, sequence_num) 已 UNIQUE——同 conversation 多次
      // seed（healing 落账测试 seed 两次）不能用硬编码 seq=1，改 MAX+1（与 createEntryAtomic 同款）
      db.prepare(`
        INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, invoke_id, yield_targets, status, sender_name, created_at, completed_at)
        VALUES (?, 'conv-1', (SELECT COALESCE(MAX(sequence_num), 0) + 1 FROM entries WHERE conversation_id = 'conv-1'), 'user', 'user', 'chen', '开工', NULL, ?, 'completed', '搭档', ?, ?)
      `).run(userEntryId, opts.userYieldTargets === null ? null : JSON.stringify(opts.userYieldTargets ?? [otterId]), createdAt, createdAt);
      db.prepare(`
        INSERT INTO invokes (id, conversation_id, otter_id, status, trigger_entry_id, started_at, metadata)
        VALUES (?, 'conv-1', ?, 'running', ?, ?, ?)
      `).run(invokeId, otterId, userEntryId, createdAt,
        opts.restricted ? JSON.stringify({ externalProfile: 'restricted' }) : null);
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
      actionLedger: opts.actionLedger,
      remoteActions: opts.remoteActions,
      bootEpoch: opts.bootEpoch ?? 42,
      pid: opts.pid,
      isPidAlive: opts.isPidAlive,
    }),
  };
  return h;
}

/** 会话夹具播种（两个 describe 共用）：conv-1 + otter-big 参与者 */
async function setupHarness(): Promise<Harness> {
  const h = makeHarness();
  const conv: Conversation = {
    id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, kind: "normal", workspaceDir: null,
    createdAt: T0, updatedAt: T0, completedAt: null, archivedAt: null,
  };
  await h.convRepo.create(conv);
  await h.otterRepo.createOtter(otterFixture("otter-big"));
  await h.convRepo.createParticipant(participantFixture("otter-big"));
  return h;
}

describe("ResumeInterruptedService（F20260916b1ea invoke 模型重建）", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
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
    expect(chain.calls[0]!.userMessageContent).toContain("[系统提醒] 服务重启导致你的执行中断");
    expect(chain.calls[0]!.userMessageContent).toContain("保留在对话中");
    // done 流转
    expect(h.queueStatus(invokeId)).toBe("done");
    // F20260906rsts 沿用：成功路径静默——零系统消息
    expect(h.systemEntries).toHaveLength(0);
  });

  it("升级前已入队的 restricted 外部 invoke：消费侧仍禁止恢复", async () => {
    const invokeId = await h.seedInterrupted({ restricted: true });
    const chain = stubChainEngine();

    await h.buildService(chain).resume();

    expect(chain.calls).toHaveLength(0);
    expect(h.queueStatus(invokeId)).toBe("exhausted");
    expect(h.systemEntries).toHaveLength(1);
    expect(h.systemEntries[0]!.body).toContain("不会自动恢复");
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
  // ─── F20261116actlg PR-B：恢复摘要注入 + 恢复轮回填 ───

it("台账摘要内嵌续跑指令：unknown 优先呈现 + 处置指引；恢复轮 invoke 回填审计锚", async () => {
    const invokeId = await h.seedInterrupted();
    const chain = stubChainEngine();
    const service = h.buildService(chain, {
      actionLedger: {
        listByInvoke: async (id: string) => id === invokeId ? [
          { actionId: "a1", deviceId: "local", onlineSessionId: null, invokeId: id, conversationId: null, toolCallId: "c1", source: "sdk-env", kind: "shell.exec", target: "npm run build", contentHash: null, contentBytes: null, status: "unknown", error: null, resultSummary: null, bootEpoch: 1, pid: null, startedAt: T0, settledAt: null },
          { actionId: "a2", deviceId: "local", onlineSessionId: null, invokeId: id, conversationId: null, toolCallId: "c2", source: "sdk-env", kind: "file.write", target: "/tmp/a.md", contentHash: null, contentBytes: null, status: "succeeded", error: null, resultSummary: null, bootEpoch: 1, pid: null, startedAt: T0, settledAt: null },
        ] : [],
      },
    });

    await service.resume();

    expect(chain.calls).toHaveLength(1);
    const content = (chain.calls[0] as { userMessageContent: string }).userMessageContent;
    expect(content).toContain("机器台账");
    expect(content).toContain("[unknown] shell.exec 命令 npm run build");
    expect(content).toContain("禁止盲目重试");
    expect(content).toContain("[succeeded] file.write /tmp/a.md");
    expect(content).toContain("不要重做");
    // 恢复轮 invoke 回填（审计链）
    const row = await h.resumeRepo.getByInvokeId(invokeId);
    expect(row?.recoveryInvokeId).toBe("new-invoke-1");
    expect(h.queueStatus(invokeId)).toBe("done");
  });

  // ─── F20261118remex（C2/R2）：远程动作五态并入恢复摘要 ───

  it("台账缺席 → 旧版文案（无摘要块）；认领绑定注入的 bootEpoch", async () => {
    const invokeId = await h.seedInterrupted();
    const chain = stubChainEngine();
    const service = h.buildService(chain, { bootEpoch: 777 });

    await service.resume();

    const content = (chain.calls[0] as { userMessageContent: string }).userMessageContent;
    expect(content).not.toContain("机器台账");
    const row = await h.resumeRepo.getByInvokeId(invokeId);
    expect(row?.bootEpoch).toBe(777);
    expect(row?.claimToken).toBeTruthy();
  });

});

// ─── F20261117 检视轮修复（PR #1902 review minor-1/minor-2 + 未覆盖点）───
describe("ResumeInterruptedService 检视轮修复（同 boot 认领冲突保持 pending / 摘要超限显性标注 / 台账查询失败退化）", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  it("同 boot 已认领（双路径并发窗口）：认领失败不 settle——保持 pending 交还原持有者〔minor-1〕", async () => {
    const invokeId = await h.seedInterrupted();
    // 模拟同 boot 另一路径已认领（同毫秒双进程/二次 resume），行仍 pending
    await h.resumeRepo.claimPendingResume(invokeId, { token: "holder-token", bootEpoch: 42, pid: 100 });

    const chain = stubChainEngine();
    await h.buildService(chain, { bootEpoch: 42 }).resume();

    expect(chain.calls).toHaveLength(0); // 不双跑
    expect(h.queueStatus(invokeId)).toBe("pending"); // 不被吞成终态——持有者继续负责闭环
    const row = await h.resumeRepo.getByInvokeId(invokeId);
    expect(row?.claimToken).toBe("holder-token"); // 原持有者不被覆盖
    expect(row?.attempts).toBe(1); // 失败认领不自增 attempts
  });

  it("台账行数达查询上限：摘要显性标注计数可能不完整〔minor-2〕", async () => {
    const invokeId = await h.seedInterrupted();
    const chain = stubChainEngine();
    const service = h.buildService(chain, {
      actionLedger: {
        listByInvoke: async (id: string, limit?: number) =>
          Array.from({ length: limit ?? 200 }, (_, i) => ({
            actionId: `a${i}`, deviceId: "local", onlineSessionId: null, invokeId: id, conversationId: null,
            toolCallId: null, source: "sdk-env", kind: "file.write", target: `/tmp/f${i}`, contentHash: null,
            contentBytes: null, status: "succeeded", error: null, resultSummary: null, bootEpoch: 1,
            pid: null, startedAt: T0, settledAt: null,
          })),
      },
    });

    await service.resume();

    const content = (chain.calls[0] as { userMessageContent: string }).userMessageContent;
    expect(content).toContain("机器台账");
    expect(content).toContain("计数可能不完整");
    expect(h.queueStatus(invokeId)).toBe("done");
  });

  it("台账查询抛错：退回旧版文案（无摘要块），恢复不受阻〔未覆盖点补测〕", async () => {
    const invokeId = await h.seedInterrupted();
    const chain = stubChainEngine();
    const service = h.buildService(chain, {
      actionLedger: { listByInvoke: async () => { throw new Error("db locked"); } },
    });

    await service.resume();

    expect(chain.calls).toHaveLength(1);
    const content = (chain.calls[0] as { userMessageContent: string }).userMessageContent;
    expect(content).not.toContain("机器台账");
    expect(h.queueStatus(invokeId)).toBe("done");
  });
});

// ─── F20261117 检视轮可优化项 S1/S2/S3（搭档裁决：可优化项做完整）───
describe("ResumeInterruptedService 可优化项完整落地（S1 持有收口/S2 审计链追加/S3 旧持有者死活预检）", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  it("S3：旧纪元持有进程仍存活 → 不抢不双跑，行保持 pending 归旧持有者", async () => {
    const invokeId = await h.seedInterrupted();
    // 旧纪元（epoch 100）持有者在途：pid 4321 存活
    await h.resumeRepo.claimPendingResume(invokeId, { token: "old-holder", bootEpoch: 100, pid: 4321 });

    const chain = stubChainEngine();
    await h.buildService(chain, { bootEpoch: 999, isPidAlive: () => true }).resume();

    expect(chain.calls).toHaveLength(0); // 不抢——旧持有者活着
    expect(h.queueStatus(invokeId)).toBe("pending");
    const row = await h.resumeRepo.getByInvokeId(invokeId);
    expect(row?.claimToken).toBe("old-holder"); // 归旧持有者
    expect(row?.attempts).toBe(1); // 预检拒抢不自增 attempts
  });

  it("S3：旧纪元持有进程已死 → 重认领接手（防死锁），pid 更新为新持有者", async () => {
    const invokeId = await h.seedInterrupted();
    await h.resumeRepo.claimPendingResume(invokeId, { token: "dead-holder", bootEpoch: 100, pid: 4321 });

    const chain = stubChainEngine();
    await h.buildService(chain, { bootEpoch: 999, pid: 7777, isPidAlive: () => false }).resume();

    expect(chain.calls).toHaveLength(1); // 接手恢复
    const row = await h.resumeRepo.getByInvokeId(invokeId);
    expect(row?.claimToken).not.toBe("dead-holder"); // 新 token
    expect(row?.claimPid).toBe(7777); // S3：pid 更新为新持有者
    expect(row?.attempts).toBe(2); // 重认领自增
    expect(h.queueStatus(invokeId)).toBe("done");
  });

  it("S3：同 boot 冲突不进 liveness 预检路径（epoch 相等不触发旧纪元预检）", async () => {
    const invokeId = await h.seedInterrupted();
    await h.resumeRepo.claimPendingResume(invokeId, { token: "holder", bootEpoch: 42, pid: 4321 });

    let probed = false;
    const chain = stubChainEngine();
    await h.buildService(chain, {
      bootEpoch: 42,
      isPidAlive: () => { probed = true; return true; },
    }).resume();

    expect(probed).toBe(false); // 同 boot（epoch 相等）不走旧纪元预检——归认领失败分支处理
    expect(chain.calls).toHaveLength(0);
    expect(h.queueStatus(invokeId)).toBe("pending");
  });

  it("S1+S2：恢复成功写入 claim_pid + 持有者收口 done + 审计链记录本轮恢复 invoke", async () => {
    const invokeId = await h.seedInterrupted();
    const chain = stubChainEngine();
    await h.buildService(chain, { bootEpoch: 42, pid: 5555 }).resume();

    const row = await h.resumeRepo.getByInvokeId(invokeId);
    expect(row?.claimPid).toBe(5555); // S3 数据承载：认领写 pid
    expect(h.queueStatus(invokeId)).toBe("done"); // S1：持有者 token 收口成功
    expect(row?.recoveryInvokeId).toBe("new-invoke-1"); // S2：审计链首轮
  });

  it("S2：崩溃重启二次恢复——审计链追加不丢首轮记录（恢复者崩溃后新开机接手）", async () => {
    const invokeId = await h.seedInterrupted();
    // 第一轮恢复成功，但模拟恢复者崩溃（行未 settle 退回 pending，审计链已记）
    const chain1 = stubChainEngine();
    await h.buildService(chain1, { bootEpoch: 42, pid: 1000 }).resume();
    h.db.prepare("UPDATE restart_pending_resumes SET status = 'pending', attempts = 0, claim_pid = 1000, boot_epoch = 42, claim_token = 'stale' WHERE invoke_id = ?").run(invokeId);

    // 第二轮：新开机（新纪元、旧 pid 已死）接手恢复
    const chain2 = stubChainEngine();
    await h.buildService(chain2, { bootEpoch: 999, pid: 2000, isPidAlive: () => false }).resume();

    const row = await h.resumeRepo.getByInvokeId(invokeId);
    expect(row?.recoveryInvokeId).toBe("new-invoke-1,new-invoke-1"); // S2：两轮全历史（stub 固定 messageId）
    expect(h.queueStatus(invokeId)).toBe("done");
  });
});

// ─── F20261118remex（#1868 阶段 4 C2/R2）：远程动作五态并入恢复摘要 ───
describe("ResumeInterruptedService 远程动作摘要并入（C2/R2）", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  it("远程动作段并入：本机台账段缺席时远程段独现，远程五态可裁决", async () => {
    await h.seedInterrupted();
    const chain = stubChainEngine();
    const service = h.buildService(chain, {
      remoteActions: {
        listByConversation: async (conversationId: string) => conversationId === "conv-1" ? [
          { actionId: "r-1", onlineSessionId: "s-1", deviceId: "conn-a", actionType: "workspace.write", status: "unknown", error: "timeout after 30000ms", result: null, createdAt: T0, settledAt: null, conversationId: "conv-1", invokeId: null },
          { actionId: "r-2", onlineSessionId: "s-1", deviceId: "conn-a", actionType: "workspace.read", status: "succeeded", error: null, result: null, createdAt: T0, settledAt: null, conversationId: "conv-1", invokeId: null },
        ] : [],
      },
    });

    await service.resume();

    const content = (chain.calls[0] as { userMessageContent: string }).userMessageContent;
    expect(content).toContain("远程动作");
    expect(content).toContain("[unknown] workspace.write @conn-a");
    expect(content).toContain("禁止盲目重试");
    expect(content).toContain("[succeeded] workspace.read @conn-a");
    expect(content).not.toContain("机器台账"); // 本机台账缺席——只有远程段
  });

  it("remoteActions 查询失败 → 远程段静默缺席（non-fatal，不阻断恢复）", async () => {
    await h.seedInterrupted();
    const chain = stubChainEngine();
    const service = h.buildService(chain, {
      remoteActions: { listByConversation: async () => { throw new Error("db locked"); } },
    });

    await service.resume();

    expect(chain.calls).toHaveLength(1); // 恢复照常
    const content = (chain.calls[0] as { userMessageContent: string }).userMessageContent;
    expect(content).not.toContain("远程动作");
  });
});
