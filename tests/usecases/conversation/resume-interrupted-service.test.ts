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

    // 系统消息说明收尾事实（成功口径：恢复已完成，内容见新发言）
    const sysMsgs = await new QueryMessage(repo).getMessages("conv-1", { senderType: "system", limit: 10 });
    expect(sysMsgs.some(m => m.segments.some(seg => seg.body.includes("恢复已完成")))).toBe(true);

    // pending 流转不受影响
    const rows = db.prepare("SELECT status FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe("done");
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
