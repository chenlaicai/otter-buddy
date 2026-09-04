/**
 * F20260826rsme ResumeInterruptedService 恢复编排测试（真 sqlite + stub 链引擎）。
 *
 * 验证：pending 消费→系统提示→prepareForRetry(保留 segments)→链引擎续跑→done 流转；
 * 并发窗口跳过降级；participant 失效跳过；链引擎抛错降级 exhausted + 失败提示；
 * senderId 从原 turn 反查。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { ResumeInterruptedService } from "@usecases/conversation/resume-interrupted-service";
import type { DispatchChainEngine } from "@usecases/conversation/dispatch-chain-engine";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { SendMessage } from "@usecases/conversation/send-message";
import { QueryMessage } from "@usecases/conversation/query-message";
import type { MemoryIndexGateway } from "@usecases/conversation/memory-index-gateway";
import type { Conversation, Turn, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

function otterFixture(id: string): Otter {
  return {
    id, name: `獭-${id}`, type: "big", status: "active",
    role: null, parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
  };
}

function participantFixture(otterId: string, overrides: Partial<ConversationParticipant> = {}): ConversationParticipant {
  return {
    id: `p-${otterId}`, conversationId: "conv-1", otterId,
    joinedAtTurnId: null, joinedAtTurnNumber: 0,
    leftAtTurnId: null, leftAtTurnNumber: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z", leftAt: null,
    lastReadTurnNumber: 0, lastActiveTurnNumber: 0,
    ...overrides,
  };
}

function stubMemoryIndex(): MemoryIndexGateway {
  return {
    indexMessage: vi.fn(), indexLinkedResource: vi.fn(), indexFeature: vi.fn(),
    indexResearch: vi.fn(), indexFeatureChunks: vi.fn(), indexResearchChunks: vi.fn(),
  };
}

/** 链引擎 stub：捕获调用参数，可配置抛错 */
function stubChainEngine(behavior: { throwError?: boolean } = {}) {
  const calls: Array<{ initialTargets: string[]; userMessageContent: string; senderId: string }> = [];
  const engine = {
    executeChain: vi.fn(async (params: { initialTargets: string[]; userMessageContent: string; senderId: string }) => {
      calls.push({ initialTargets: params.initialTargets, userMessageContent: params.userMessageContent, senderId: params.senderId });
      if (behavior.throwError) throw new Error("chain exploded");
      return { otterReply: undefined };
    }),
    calls,
  };
  return engine as unknown as DispatchChainEngine & { calls: typeof calls };
}

/** 中断现场：failed 消息 + pending 记录（reconcile 已跑过的状态） */
async function seedInterrupted(
  db: Database.Database,
  repo: SqliteConversationRepository,
  opts: { withSegments?: string; lastUserMsgAt?: string } = {},
): Promise<string> {
  const msgId = crypto.randomUUID();
  const seq = 1;
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at, completed_at)
    VALUES (?, 'conv-1', 'otter', 'otter-big', 'failed', ?, 'turn-1', NULL, '中断獭', ?, ?)
  `).run(msgId, seq, "2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z");
  if (opts.withSegments) {
    db.prepare(
      "INSERT INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, 0, ?)",
    ).run(crypto.randomUUID(), msgId, opts.withSegments, "2026-01-01T00:00:01Z");
  }
  db.prepare(`
    INSERT INTO restart_pending_resumes (message_id, conversation_id, otter_id, attempts, status, created_at)
    VALUES (?, 'conv-1', 'otter-big', 1, 'pending', '2026-01-01T00:00:02Z')
  `).run(msgId);
  return msgId;
}


/** 多会话版中断现场播种（F1 并行测试用） */
async function seedInterruptedIn(db: Database.Database, repo: SqliteConversationRepository, conversationId: string): Promise<string> {
  const msgId = crypto.randomUUID();
  // conv-1 的 turn 由 seedStandardConversation 命名为 turn-1；新会话为 turn-<convId>
  const turnId = conversationId === "conv-1" ? "turn-1" : `turn-${conversationId}`;
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at, completed_at)
    VALUES (?, ?, 'otter', 'otter-big', 'failed', 1, ?, NULL, '中断獭', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')
  `).run(msgId, conversationId, turnId);
  db.prepare(`
    INSERT INTO restart_pending_resumes (message_id, conversation_id, otter_id, attempts, status, created_at)
    VALUES (?, ?, 'otter-big', 1, 'pending', '2026-01-01T00:00:02Z')
  `).run(msgId, conversationId);
  return msgId;
}

/** 标准测试会话装配：conv-1 + turn-1 + 原始用户消息（senderId 反查锚）——beforeEach 瘦身提取 */
async function seedStandardConversation(db: Database.Database, repo: SqliteConversationRepository): Promise<void> {
  const conv: Conversation = {
    id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, workspaceDir: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null, archivedAt: null,
  };
  await repo.create(conv);
  const turn: Turn = {
    id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
    createdAt: "2026-01-01T00:00:00Z", closedAt: null,
  };
  await repo.createTurn(turn);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at, completed_at)
    VALUES (?, 'conv-1', 'user', 'chen', 'completed', 0, 'turn-1', '["otter-big"]', '搭档', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run(crypto.randomUUID());
}

/** 台账 stub 工厂：F202609048840 F4 判据注入用 */
function stubLedger(getAttemptImpl: () => { status: string; note: string | null } | null): { getAttempt: (messageId: string, targetOtterId: string) => { status: string; note: string | null } | null } {
  return { getAttempt: getAttemptImpl };
}

describe("ResumeInterruptedService（F20260826rsme）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;
  let sm: SendMessage;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    otterRepo = new SqliteOtterRepository(db);
    await seedStandardConversation(db, repo);
    sm = new SendMessage(repo, otterRepo, stubMemoryIndex(), createTestLogger());
  });

  afterEach(() => {
    db.close();
  });

  function buildService(chain: DispatchChainEngine & { calls: unknown[] }, delayMs = 0): ResumeInterruptedService {
    return new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      logger: createTestLogger(),
      delayMs,
    });
  }

  it("基础恢复：系统提示 + 链引擎续跑 + segments 保留 + done 流转", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截发言内容" });
    const chain = stubChainEngine();

    await buildService(chain).resume();

    // 链引擎被调用，目标是中断獭，提醒文案注入
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]).toMatchObject({ initialTargets: ["otter-big"], senderId: "chen" });
    expect((chain.calls[0] as { userMessageContent: string }).userMessageContent).toContain("[系统提醒] 服务重启导致你的发言中断");

    // 消息被重置为 streaming（恢复进行中），半截内容保留
    // #599 终态守卫：链结束后旧消息收尾 failed（恢复后内容写入新消息，
    // 旧消息悬挂 streaming 无写入者即僵尸发言——旧断言 "streaming" 固化的正是该缺陷）
    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("failed");
    expect(stored?.segments.some(seg => seg.body === "半截发言内容")).toBe(true);

    // pending 记录流转 done
    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("done");

    // 恢复开始前有系统提示（sendSystem 落库的 completed system 消息）
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 5 });
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("正在自动恢复")))).toBe(true);
  });

  it("并发窗口内有新 user 消息：跳过恢复 + exhausted + 降级提示", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });
    // 窗口内的最新 user 消息（now 时刻）
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at, completed_at)
      VALUES (?, 'conv-1', 'user', 'chen', 'completed', 5, 'turn-1', '["otter-big"]', '搭档', ?, ?)
    `).run(crypto.randomUUID(), new Date().toISOString(), new Date().toISOString());

    const chain = stubChainEngine();
    await buildService(chain).resume();

    expect(chain.calls).toHaveLength(0); // 未触发链引擎
    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("exhausted");
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 5 });
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("跳过自动恢复")))).toBe(true);
  });

  it("participant 已失效：直接 exhausted，不触发链引擎", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big", { status: "left", leftAt: "2026-01-02T00:00:00Z" }));
    const msgId = await seedInterrupted(db, repo);

    const chain = stubChainEngine();
    await buildService(chain).resume();

    expect(chain.calls).toHaveLength(0);
    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("exhausted");
  });

  it("链引擎抛错：failed + 失败提示，用户可手动重试", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });
    const chain = stubChainEngine({ throwError: true });

    await buildService(chain).resume();

    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    // F202609048840 F4: 现在链引擎抛错标记为 failed（可手动重试），而不是 exhausted
    expect(rows[0]?.status).toBe("failed");
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 5 });
    // F202609048840 F4: 更新断言以匹配新的消息
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("恢复过程中 invoke 失败")))).toBe(true);
    // 失败路径同样保留半截内容（prepareForRetry preserveSegments 已执行），与基础恢复用例对称
    const stored = await repo.getMessageById(msgId);
    expect(stored?.segments.some(seg => seg.body === "半截")).toBe(true);
  });

  it("无 pending 记录：静默返回，无系统消息无链调用", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    const chain = stubChainEngine();
    await buildService(chain).resume();
    expect(chain.calls).toHaveLength(0);
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 5 });
    expect(sysMsgs).toHaveLength(0);
  });


  // F20260830rfto: 多 conversation 容错测试
  it("多 conversation 一个失败不阻塞其余：第一个链引擎抛错，第二个正常恢复", async () => {
    // Setup: 两个 conversation 各有一个 pending
    await otterRepo.createOtter(otterFixture("otter-big"));
    await otterRepo.createOtter(otterFixture("otter-small"));

    // conv-1 participant
    await repo.createParticipant(participantFixture("otter-big"));

    // conv-2
    const conv2: Conversation = {
      id: "conv-2", title: "测试对话2", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    await repo.create(conv2);
    const turn2: Turn = {
      id: "turn-2", conversationId: "conv-2", turnNumber: 1, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    await repo.createTurn(turn2);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at, completed_at)
      VALUES (?, 'conv-2', 'user', 'chen', 'completed', 0, 'turn-2', '["otter-small"]', '搭档', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run(crypto.randomUUID());
    await repo.createParticipant(participantFixture("otter-small", { id: "p-small", conversationId: "conv-2" }));

    // Seed: conv-1 的 resume 会抛错，conv-2 正常
    const msgId1 = await seedInterrupted(db, repo, { withSegments: "半截1" });
    const msgId2 = seedInterruptedConv(db, "conv-2", "otter-small", { withSegments: "半截2" });

    // 链引擎：第一次调用（conv-1）抛错，第二次（conv-2）正常
    const calls: Array<{ conversationId: string }> = [];
    const chain = {
      executeChain: vi.fn(async (params: { conversationId: string; initialTargets: string[]; userMessageContent: string; senderId: string }) => {
        calls.push({ conversationId: params.conversationId });
        if (params.conversationId === "conv-1") throw new Error("chain exploded for conv-1");
        return { otterReply: undefined };
      }),
    } as unknown as DispatchChainEngine;

    await buildService(chain as unknown as DispatchChainEngine & { calls: unknown[] }).resume();

    // conv-1: failed（F202609048840 F4：链抛错标 failed 可手动重试，不再 exhausted）
    const rows1 = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId1) as Array<{ status: string }>;
    expect(rows1[0]?.status).toBe("failed");

    // conv-2: done（未被 conv-1 的失败阻塞）
    const rows2 = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId2) as Array<{ status: string }>;
    expect(rows2[0]?.status).toBe("done");

    // 两个 conversation 都被处理了
    expect(calls).toHaveLength(2);
  });

  it("sendSystem 失败不阻塞 resume 消费：系统消息抛错但链引擎仍执行", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });

    const chain = stubChainEngine();
    // sendSystem 抛错
    const failingSm = {
      ...sm,
      sendSystem: vi.fn(async () => { throw new Error("sendSystem exploded"); }),
      prepareForRetry: sm.prepareForRetry.bind(sm),
      fail: sm.fail.bind(sm),
    } as unknown as SendMessage;

    const service = new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: failingSm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      logger: createTestLogger(),
      delayMs: 0,
    });

    await service.resume();

    // 链引擎仍被调用（sendSystem 失败不阻塞）
    expect(chain.calls).toHaveLength(1);
    // resume 正常完成
    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("done");
  });

  it("#599 终态守卫：成功路径旧消息收尾归档，不再悬挂 streaming", async () => {
    // Why(#599): 恢复路径 invoke 创建的是新消息（新 messageId），prepareForRetry 复位的
    // 旧消息在链结束后无人写入——悬挂 streaming 等用户手动中断即僵尸发言。
    // 守卫语义：链正常结束时，旧消息收尾 failed（半截内容保留），系统消息说明去向。
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });
    const chain = stubChainEngine();

    await buildService(chain).resume();

    // 链引擎被正常调用（成功路径）
    expect(chain.calls).toHaveLength(1);

    // 旧消息已收尾：不再是 streaming（僵尸态），而是 failed（可在原条目手动重试）
    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("failed");
    // 半截内容保留（fail 不动 segments）
    expect(stored?.segments.some(seg => seg.body === "半截")).toBe(true);

    // F202609048840 F3: 由于旧消息不再复位为 streaming，而是保持 failed 状态，
    // canFailMessage 返回 false，因此不会调用 sendMessage.fail，不会写入 "恢复已完成" 的消息
    // 这是预期的行为：旧消息保持 failed 状态，恢复链写新消息
    expect(stored?.segments.some(seg => seg.body.includes("恢复已完成"))).toBe(false);
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 10 });
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("恢复已完成")))).toBe(false);

    // pending 流转不受影响
    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("done");
  });

  // F20260830rfto: 429 限流错误从 resumeOne 传播到 resumeOneWithRetry（修复审查建议1）
  // 核心验证：429 错误不被 resumeOne 内层 catch 吞掉，而是传播到 resumeOneWithRetry 的退避重试
  it("429 限流错误传播到重试层：链引擎报 429 时触发退避重试", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });

    // 链引擎始终报429（所有重试都失败 → exhausted）
    const chain = {
      executeChain: vi.fn(async () => {
        throw new Error("429 Too Many Requests");
      }),
    } as unknown as DispatchChainEngine;

    const service = new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      logger: createTestLogger(),
      delayMs: 0,
      rateLimitBaseDelayMs: 1, // 测试用：1ms 退避
    });

    await service.resume();

    // 429 重试路径真实可达的状态断言（检视发现 1 处置；调用次数断言被 no-restricted-syntax 禁）：
    // 重试耗尽的 429 走「可重试错误终态」= 队列 failed + 失败文案（resumeItemSafe 可重试分支）；
    // 旧 bug 形态（内层吞 429 零重试）在旧代码语义下标 exhausted——failed 断言即区分两者
    // 全部重试失败 → failed（F202609048840 F4：重试耗尽的链错误标 failed 可手动重试，不再 exhausted）
    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("failed");
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 8 });
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("恢复过程中 invoke 失败")))).toBe(true);
  });

  it("#599 终态守卫：消息已被处理到终态时守卫不覆盖（no-clobber）", async () => {
    // Why(#599): 守卫只收尾仍可 fail 的消息（streaming/speaking）。
    // 若恢复窗口内用户已手动处理（消息已 completed/aborted），
    // 守卫不得把终态改写为 failed——状态机只进不退。
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });

    // 恢复前：用户已手动把该消息处理到终态（模拟手动重试后完成）
    db.prepare("UPDATE messages SET status = 'completed', completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), msgId);

    const chain = stubChainEngine();
    await buildService(chain).resume();

    // 链正常跑（prepareForRetry 对 completed 抛冲突 → catch 降级，但消息终态不被改写）
    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("completed");
  });
});

describe("#613 恢复流终态反馈 + healing 台账落账", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;
  let sm: SendMessage;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    otterRepo = new SqliteOtterRepository(db);

    const conv: Conversation = {
      id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    await repo.create(conv);
    const turn: Turn = {
      id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    await repo.createTurn(turn);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at, completed_at)
      VALUES (?, 'conv-1', 'user', 'chen', 'completed', 0, 'turn-1', '["otter-big"]', '搭档', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run(crypto.randomUUID());

    sm = new SendMessage(repo, otterRepo, stubMemoryIndex(), createTestLogger());
  });

  afterEach(() => {
    db.close();
  });

  function buildService(chain: DispatchChainEngine & { calls: unknown[] }, delayMs = 0): ResumeInterruptedService {
    return new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      logger: createTestLogger(),
      delayMs,
    });
  }


  // ── #613 方案 A：恢复完成终态消息 ──

  it("#613 方案 A：恢复完成后发终态消息「N 条已恢复」", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    await seedInterrupted(db, repo, { withSegments: "半截" });
    const chain = stubChainEngine();

    await buildService(chain).resume();

    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 10 });
    // 恢复完成终态消息（成功路径与失败路径的 [错误] 消息对称）
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("恢复完成")))).toBe(true);
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("1 条中断发言已恢复")))).toBe(true);
  });

  it("#613 方案 A：部分失败时终态消息含「M 条未能恢复」", async () => {
    // conv-1 一条成功、conv-2 一条失败（链引擎对 conv-2 抛错）
    await otterRepo.createOtter(otterFixture("otter-big"));
    await otterRepo.createOtter(otterFixture("otter-small"));
    await repo.createParticipant(participantFixture("otter-big"));
    const conv2: Conversation = {
      id: "conv-2", title: "测试对话2", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    await repo.create(conv2);
    const turn2: Turn = {
      id: "turn-2", conversationId: "conv-2", turnNumber: 1, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    await repo.createTurn(turn2);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at, completed_at)
      VALUES (?, 'conv-2', 'user', 'chen', 'completed', 0, 'turn-2', '["otter-small"]', '搭档', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run(crypto.randomUUID());
    await repo.createParticipant(participantFixture("otter-small", { id: "p-small", conversationId: "conv-2" }));

    await seedInterrupted(db, repo, { withSegments: "半截1" });
    seedInterruptedConv(db, "conv-2", "otter-small", { withSegments: "半截2" });

    const chain = {
      executeChain: vi.fn(async (params: { conversationId: string }) => {
        if (params.conversationId === "conv-2") throw new Error("chain exploded");
        return { otterReply: undefined };
      }),
    } as unknown as DispatchChainEngine;

    await buildService(chain as unknown as DispatchChainEngine & { calls: unknown[] }).resume();

    // conv-1：1 条已恢复
    const sysMsgs1 = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 10 });
    expect(sysMsgs1.some(m => m.segments.some(seg => seg.body.includes("1 条中断发言已恢复")))).toBe(true);
    // conv-2：1 条未能恢复（新文案：失败单独列出，不带「0 条已恢复」前缀）
    const sysMsgs2 = await new QueryMessage(repo).getMessages("conv-2", { senderType: "system", limit: 10 });
    expect(sysMsgs2.some(m => m.segments.some(seg => seg.body.includes("1 条未能恢复（请手动重试）")))).toBe(true);
  });

  it("#617 检视发现1：stale data（participant 失效）被统计为「已跳过」，不带「请手动重试」误导", async () => {
    // Why: resumeOne 返回 "skipped"（stale 数据清理）此前被计入 "failed"，
    // 终态消息显示「请手动重试」对已 exhausted 的过期数据无操作指引意义。
    // 修复后 skipped 与 failed 分开统计，文案精确区分。
    await otterRepo.createOtter(otterFixture("otter-big"));
    // participant status=left 模拟 stale 现场（服务重启间隙参与者已离开）
    await repo.createParticipant(participantFixture("otter-big", { status: "left", leftAt: "2026-01-02T00:00:00Z" }));
    await seedInterrupted(db, repo);
    const chain = stubChainEngine();

    await buildService(chain).resume();

    expect(chain.calls).toHaveLength(0); // stale 数据不触发链引擎
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 10 });
    const completedMsg = sysMsgs.find(m => m.segments.some(seg => seg.body.includes("恢复完成")));
    expect(completedMsg).toBeDefined();
    const body = completedMsg!.segments.map(s => s.body).join("");
    // 关键断言：skipped 走「已跳过」分支，不出现「请手动重试」
    expect(body).toContain("1 条已跳过（过期/并发，无需处理）");
    expect(body).not.toContain("请手动重试");
    // pending 记录已被 exhausted 清理（resumeOne 内 updateResumeStatus）
    const rows = db.prepare("SELECT status FROM restart_pending_resumes").all() as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("exhausted");
  });
});

describe("#613 方案 B：healing 台账落账", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;
  let sm: SendMessage;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    otterRepo = new SqliteOtterRepository(db);

    const conv: Conversation = {
      id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    await repo.create(conv);
    const turn: Turn = {
      id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    await repo.createTurn(turn);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at, completed_at)
      VALUES (?, 'conv-1', 'user', 'chen', 'completed', 0, 'turn-1', '["otter-big"]', '搭档', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run(crypto.randomUUID());

    sm = new SendMessage(repo, otterRepo, stubMemoryIndex(), createTestLogger());
  });

  afterEach(() => {
    db.close();
  });

  it("#613 方案 B：恢复执行时落一条 healing event（severity=low，1 条中断）", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    await seedInterrupted(db, repo, { withSegments: "半截" });
    const chain = stubChainEngine();
    const healingRepo = {
      create: vi.fn(async () => {}),
    } as unknown as HealingEventRepository & { create: ReturnType<typeof vi.fn> };

    const service = new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      logger: createTestLogger(),
      healingRepo,
      delayMs: 0,
    });
    await service.resume();

    // 落了一条 healing event，severity=low（1 条中断）
    expect(healingRepo.create).toHaveBeenCalled();
    expect(healingRepo.create.mock.calls).toHaveLength(1);
    const event = healingRepo.create.mock.calls[0][0];
    expect(event.errorType).toBe("other");
    expect(event.severity).toBe("low");
    expect(event.description).toContain("1 条发言中断");
  });

  it("#613 方案 B：severity 按中断发言数分级（≥2 条=medium）", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    // 同一 conversation 两条中断发言
    await seedInterrupted(db, repo, { withSegments: "半截1" });
    seedInterruptedConv(db, "conv-1", "otter-big", { withSegments: "半截2" });
    const chain = stubChainEngine();
    const healingRepo = {
      create: vi.fn(async () => {}),
    } as unknown as HealingEventRepository & { create: ReturnType<typeof vi.fn> };

    const service = new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      logger: createTestLogger(),
      healingRepo,
      delayMs: 0,
    });
    await service.resume();

    expect(healingRepo.create).toHaveBeenCalled();
    expect(healingRepo.create.mock.calls).toHaveLength(1);
    const event = healingRepo.create.mock.calls[0][0];
    expect(event.severity).toBe("medium");
    expect(event.description).toContain("2 条发言中断");
  });

  it("#617 检视发现2：severity 分级边界 ≥5 条=high（阈值回归锁定）", async () => {
    // Why: 检视发现 severity=high（≥5 条中断）分支无测试锁定——若阈值被误改为 > 5，
    // low/medium 测试不会回归。本测试固定 ≥5 → high 的边界行为。
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    // 同一 conversation 5 条中断发言（≥5 触发 high）
    for (let i = 0; i < 5; i++) {
      seedInterruptedConv(db, "conv-1", "otter-big", { withSegments: `半截${i}` });
    }
    const chain = stubChainEngine();
    const healingRepo = {
      create: vi.fn(async () => {}),
    } as unknown as HealingEventRepository & { create: ReturnType<typeof vi.fn> };

    const service = new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      logger: createTestLogger(),
      healingRepo,
      delayMs: 0,
    });
    await service.resume();

    expect(healingRepo.create).toHaveBeenCalled();
    expect(healingRepo.create.mock.calls).toHaveLength(1);
    const event = healingRepo.create.mock.calls[0][0];
    expect(event.severity).toBe("high");
    expect(event.description).toContain("5 条发言中断");
  });

  it("#613 方案 B：无 pending 记录时不落 healing event", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    const chain = stubChainEngine();
    const healingRepo = {
      create: vi.fn(async () => {}),
    } as unknown as HealingEventRepository & { create: ReturnType<typeof vi.fn> };

    const service = new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      logger: createTestLogger(),
      healingRepo,
      delayMs: 0,
    });
    await service.resume();

    expect(healingRepo.create).not.toHaveBeenCalled();
  });

  it("#613 方案 B：healing event 写入失败不阻塞恢复流程（non-fatal）", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });
    const chain = stubChainEngine();
    const healingRepo = {
      create: vi.fn(async () => { throw new Error("healing db exploded"); }),
    } as unknown as HealingEventRepository & { create: ReturnType<typeof vi.fn> };

    const service = new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      logger: createTestLogger(),
      healingRepo,
      delayMs: 0,
    });
    await service.resume();

    // healing 写入失败但恢复流程正常完成
    expect(chain.calls).toHaveLength(1);
    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("done");
  });

  // ── F202609048840 F4：done 语义判据（台账真相源）专项 ──
  describe("F202609048840 F4 done 语义判据", () => {
  // F202609048840 F4：现场实证场景——链引擎对 invoke 拒绝是 allSettled 吞错语义，
  // executeChain 正常返回但台账 settle=failed（2026-09-04 17:58 实景：恢复 invoke 秒败，
  // 旧判据漏判 → done 说谎）。台账判据必须在此场景标 failed。
  it("链吞错返回但台账 settle=failed：标 failed 不说谎，用户可手动重试", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });
    const chain = stubChainEngine(); // executeChain 正常返回（不抛）
    // note 用非网络类：网络类已升级为可重试（F2 真实落点），本用例锁"不可重试 failed 标 failed"
    const ledger = stubLedger(() => ({ status: "failed", note: "invoke aborted by guard" }));

    const service = new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      dispatchAttemptRepo: ledger,
      logger: createTestLogger(),
      delayMs: 0,
    });

    await service.resume();

    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("failed"); // 不再 done 说谎
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 5 });
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("恢复过程中 invoke 失败")))).toBe(true);
  });

  it("台账判据保守降级：无台账行（记账链路异常）时链正常返回仍标 done", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });
    const chain = stubChainEngine();
    const ledger = stubLedger(() => null); // 无行：保守判成功

    const service = new ResumeInterruptedService({
      conversationRepo: repo,
      queryMessage: new QueryMessage(repo),
      sendMessage: sm,
      dispatchChainEngine: chain,
      invokeFn: async () => ({ messageId: "invoked-msg" }),
      dispatchAttemptRepo: ledger,
      logger: createTestLogger(),
      delayMs: 0,
    });

    await service.resume();

    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("done"); // 观测缺失不误判
  });
  });
});



/** 为非默认 conversation seed 中断记录（seedInterrupted 硬编码 conv-1） */
function seedInterruptedConv(
  db: Database.Database,
  conversationId: string,
  otterId: string,
  opts: { withSegments?: string } = {},
): string {
  const msgId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at, completed_at)
    VALUES (?, ?, 'otter', ?, 'failed', 1, ?, NULL, '中断獭', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')
  `).run(msgId, conversationId, otterId, conversationId === "conv-2" ? "turn-2" : "turn-1");
  if (opts.withSegments) {
    db.prepare(
      "INSERT INTO message_segments (id, message_id, body, sequence_num, created_at) VALUES (?, ?, ?, 0, ?)",
    ).run(crypto.randomUUID(), msgId, opts.withSegments, "2026-01-01T00:00:01Z");
  }
  db.prepare(`
    INSERT INTO restart_pending_resumes (message_id, conversation_id, otter_id, attempts, status, created_at)
    VALUES (?, ?, ?, 1, 'pending', '2026-01-01T00:00:02Z')
  `).run(msgId, conversationId, otterId);
  return msgId;
}

// ── F202609048840 检视发现 3 处置：F1/F2/F5 补测（原文档声明与实际不符） ──
describe("F202609048840 恢复修复专项（F1/F2/F5）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;
  let sm: SendMessage;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    otterRepo = new SqliteOtterRepository(db);
    await seedStandardConversation(db, repo);
    sm = new SendMessage(repo, otterRepo, stubMemoryIndex(), createTestLogger());
  });

  afterEach(() => {
    db.close();
  });

  // ── F202609048840 检视发现 3 处置：F1/F2/F5 补测（原文档声明与实际不符） ──
  describe("F202609048840 F1 跨会话并行", () => {
    it("三会话并行恢复：互不阻塞（前两会话链挂起时第三会话已完成）", async () => {
      const order: string[] = [];
      const release = new Map<string, () => void>();
      const convs = ["conv-1", "conv-2", "conv-3"];
      await otterRepo.createOtter(otterFixture("otter-big")); // 三个会话共用同一只獭
      for (const convId of convs) {
        if (convId !== "conv-1") {
          await repo.create({ id: convId, title: `对话${convId}`, status: "active", summary: null, pinned: false, workspaceDir: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", completedAt: null, archivedAt: null });
          await repo.createTurn({ id: `turn-${convId}`, conversationId: convId, turnNumber: 1, status: "open", createdAt: "2026-01-01T00:00:00Z", closedAt: null });
        }
        // conv-1 的会话/turn 由 beforeEach 的 seedStandardConversation 提供
        await repo.createParticipant(participantFixture("otter-big", { conversationId: convId, id: `p-${convId}-otter-big` }));
      }
      const msgIds: string[] = [];
      for (const convId of convs) {
        msgIds.push(await seedInterruptedIn(db, repo, convId));
      }
      // conv-1/conv-2 链挂起（等 release），conv-3 立即完成
      const chain = {
        executeChain: vi.fn(async (params: { conversationId: string }) => {
          order.push(`start:${params.conversationId}`);
          if (params.conversationId === "conv-3") {
            order.push("done:conv-3");
            return {};
          }
          await new Promise<void>(resolve => release.set(params.conversationId, resolve));
          order.push(`done:${params.conversationId}`);
          return {};
        }),
      } as unknown as DispatchChainEngine;
      const service = new ResumeInterruptedService({
        conversationRepo: repo, queryMessage: new QueryMessage(repo), sendMessage: sm,
        dispatchChainEngine: chain, invokeFn: async () => ({ messageId: "m" }),
        logger: createTestLogger(), delayMs: 0,
      });
      const resumePromise = service.resume();
      await new Promise(r => setTimeout(r, 50));
      // conv-1/conv-2 挂起中，conv-3 已完成——串行实现下 conv-3 永远到不了（排第三）
      expect(order).toContain("done:conv-3");
      const row3 = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").get(msgIds[2]) as { status: string };
      expect(row3.status).toBe("done");
      release.get("conv-1")!();
      release.get("conv-2")!();
      await resumePromise;
      expect(order.filter(x => x.startsWith("done:"))).toHaveLength(3);
    });
  });

  describe("F202609048840 F2 网络类重试（真实落点：台账 note）", () => {
    it("链吞错返回 + 台账 note=Connection error：触发 3 次退避重试后标 failed", async () => {
      await otterRepo.createOtter(otterFixture("otter-big"));
      await repo.createParticipant(participantFixture("otter-big"));
      const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });
      const chain = stubChainEngine(); // 正常返回（吞错语义）
      let calls = 0;
      const ledger = {
        getAttempt: () => {
          calls++;
          return { status: "failed", note: "Connection error: fetch failed" };
        },
      };
      const service = new ResumeInterruptedService({
        conversationRepo: repo, queryMessage: new QueryMessage(repo), sendMessage: sm,
        dispatchChainEngine: chain, invokeFn: async () => ({ messageId: "m" }),
        dispatchAttemptRepo: ledger as never,
        logger: createTestLogger(), delayMs: 0, rateLimitBaseDelayMs: 1,
      });
      await service.resume();
      // 判定 4 次 = 初始 1 + 重试 3（重试层真实可达性锁定——检视发现 1 修复的验收）
      expect(calls).toBe(4);
      const row = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").get(msgId) as { status: string };
      expect(row.status).toBe("failed");
    });

    it("台账 note 非网络类（如内部错误）：不重试快速终态", async () => {
      await otterRepo.createOtter(otterFixture("otter-big"));
      await repo.createParticipant(participantFixture("otter-big"));
      const msgId = await seedInterrupted(db, repo);
      const chain = stubChainEngine();
      let calls = 0;
      const ledger = {
        getAttempt: () => {
          calls++;
          return { status: "failed", note: "some internal logic error" };
        },
      };
      const service = new ResumeInterruptedService({
        conversationRepo: repo, queryMessage: new QueryMessage(repo), sendMessage: sm,
        dispatchChainEngine: chain, invokeFn: async () => ({ messageId: "m" }),
        dispatchAttemptRepo: ledger as never,
        logger: createTestLogger(), delayMs: 0, rateLimitBaseDelayMs: 1,
      });
      await service.resume();
      expect(calls).toBe(1); // 零重试
      const row = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").get(msgId) as { status: string };
      expect(row.status).toBe("failed");
    });
  });

  describe("F202609048840 F5 时间戳", () => {
    it("队列 updated_at 为完成时刻而非 resumeOne 开跑快照（检视发现 7：真实时钟锚定，旧实现必挂）", async () => {
      await otterRepo.createOtter(otterFixture("otter-big"));
      await repo.createParticipant(participantFixture("otter-big"));
      const msgId = await seedInterrupted(db, repo);
      // 链内注入 1.1s 延迟：开跑时刻与完成时刻拉开可分辨间隔（种子时间硬编码 2026-01-01
      // 不可作锚——真实时钟下恒真，检视发现 7）
      const chain = {
        executeChain: vi.fn(async () => {
          await new Promise(r => setTimeout(r, 1100));
          return {};
        }),
      } as unknown as DispatchChainEngine;
      const svc = new ResumeInterruptedService({
        conversationRepo: repo, queryMessage: new QueryMessage(repo), sendMessage: sm,
        dispatchChainEngine: chain, invokeFn: async () => ({ messageId: "m" }),
        logger: createTestLogger(), delayMs: 0,
      });
      const beforeResume = Date.now(); // 真实时钟锚：resumeOne 开跑前的时刻
      await svc.resume();
      const row = db.prepare("SELECT updated_at FROM restart_pending_resumes WHERE message_id = ?").get(msgId) as { updated_at: string };
      // 旧实现（快照语义）写入的是 beforeResume 附近的时刻，必然 < beforeResume + 1100ms − 容差；
      // 新实现（完成时刻）必然 ≥ beforeResume + 1100ms − 容差（容差吸收调度抖动）
      expect(Date.parse(row.updated_at)).toBeGreaterThanOrEqual(beforeResume + 1000);
    });
  });
});
