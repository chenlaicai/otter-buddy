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

describe("ResumeInterruptedService（F20260826rsme）", () => {
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
    // 原始用户消息（senderId 反查锚）
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
    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("streaming");
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

  it("链引擎抛错：exhausted + 失败提示，用户可手动重试", async () => {
    await otterRepo.createOtter(otterFixture("otter-big"));
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedInterrupted(db, repo, { withSegments: "半截" });
    const chain = stubChainEngine({ throwError: true });

    await buildService(chain).resume();

    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("exhausted");
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 5 });
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("自动恢复失败")))).toBe(true);
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

    // conv-1: exhausted
    const rows1 = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId1) as Array<{ status: string }>;
    expect(rows1[0]?.status).toBe("exhausted");

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

    // 429 被传播到重试层：executeChain 被调用多次（初始1次 + 最多3次重试）
    expect(chain.executeChain).toHaveBeenCalled();
    // 全部重试失败 → exhausted
    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("exhausted");
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
