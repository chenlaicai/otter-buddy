/**
 * F20260826rsme reconcileOrphans 恢复队列分流测试（真 sqlite）。
 *
 * 验证：可恢复中断（active participant + 原子守卫首次通过）入队且 fail 不插 notice；
 * 守卫拒绝（二次重启 attempts 已满）走现状 fail+notice；不可恢复（left participant）
 * 走现状 fail+notice；所有 streaming/speaking 消息无悬挂（都到 failed 终态）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { reconcileOrphans } from "@usecases/conversation/reconcile-orphans";
import type { Conversation, Turn, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

function otterFixture(overrides: Partial<Otter> = {}): Otter {
  return {
    id: "otter-big", name: "大獭", type: "big", status: "active",
    role: null, parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
    ...overrides,
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

/** 直接落库一条 streaming 消息（模拟中断现场：发言进行中进程被杀）。
 *  Why: 走 repo 层 insert 而非 SendMessage.start——left participant 场景下
 *  send() 会因无可用派发目标抛错，中断现场模拟必须绕开目标解析。 */
async function seedStreamingMessage(
  repo: SqliteConversationRepository,
  senderId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const seq = ((await repo.getMaxSequenceNum("conv-1")) ?? 0) + 1;
  const db = (repo as unknown as { db: Database.Database }).db;
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at)
    VALUES (?, ?, 'otter', ?, 'streaming', ?, 'turn-1', NULL, '中断獭', ?)
  `).run(id, "conv-1", senderId, seq, new Date().toISOString());
  return id;
}

describe("reconcileOrphans 恢复队列分流（F20260826rsme）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let otterRepo: SqliteOtterRepository;

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
  });

  afterEach(() => {
    db.close();
  });

  it("可恢复中断（active participant）：入队 + fail 不插 notice", async () => {
    await otterRepo.createOtter(otterFixture());
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedStreamingMessage(repo, "otter-big");

    await reconcileOrphans(repo, createTestLogger());

    const pending = await repo.getPendingResumes();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ messageId: msgId, conversationId: "conv-1", otterId: "otter-big" });

    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("failed");
    // 恢复队列内的消息不应有中断 notice（会污染续写内容）
    expect(stored?.segments.some(seg => seg.body.includes("[服务重启，发言中断]"))).toBe(false);
  });

  it("二次重启（attempts 已满）：守卫拒绝 → 现状 fail+notice，不二次入队消费", async () => {
    await otterRepo.createOtter(otterFixture());
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedStreamingMessage(repo, "otter-big");

    // 第一次重启：入队
    await reconcileOrphans(repo, createTestLogger());
    // 模拟恢复中再次崩溃：消息回到 streaming（prepareForRetry 已执行但进程被杀）
    db.prepare("UPDATE messages SET status = 'streaming' WHERE id = ?").run(msgId);

    // 第二次重启：守卫应拒绝（attempts=1 已达上限），走现状 fail+notice
    await reconcileOrphans(repo, createTestLogger());

    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("failed");
    expect(stored?.segments.some(seg => seg.body.includes("[服务重启，发言中断]"))).toBe(true);
    // pending 记录仍是 1 条（幂等主键），attempts 停在 1
    const rows = db.prepare("SELECT * FROM restart_pending_resumes WHERE message_id = ?").all(msgId) as Array<{ attempts: number; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(1);
    // 二次 reconcile 不应把 status 改回 pending 或新增记录
    expect(rows[0].status).toBe("pending");
  });

  it("不可恢复（participant 已 left）：现状 fail+notice，不入队", async () => {
    await otterRepo.createOtter(otterFixture());
    await repo.createParticipant(participantFixture("otter-big", { status: "left", leftAt: "2026-01-02T00:00:00Z" }));
    const msgId = await seedStreamingMessage(repo, "otter-big");

    await reconcileOrphans(repo, createTestLogger());

    const pending = await repo.getPendingResumes();
    expect(pending).toHaveLength(0);
    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("failed");
    expect(stored?.segments.some(seg => seg.body.includes("[服务重启，发言中断]"))).toBe(true);
  });

  it("孤儿 turn 关闭不变量保持：入队消息的 turn 也被关闭（open = 有进行中发言）", async () => {
    await otterRepo.createOtter(otterFixture());
    await repo.createParticipant(participantFixture("otter-big"));
    await seedStreamingMessage(repo, "otter-big");

    await reconcileOrphans(repo, createTestLogger());

    const history = await repo.getTurnHistory("conv-1");
    expect(history.every(t => t.turn.status === "closed")).toBe(true);
  });

  // F20260827mtbl：复现生产现场——存量库缺 restart_pending_resumes 表时
  // claimResume 抛 no such table，旧实现整个 reconcile 夭折，streaming 孤儿永久残留。
  it("缺恢复队列表：claim 异常降级 fail+notice，清理不中断（F20260827mtbl）", async () => {
    await otterRepo.createOtter(otterFixture());
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedStreamingMessage(repo, "otter-big");
    // 模拟未跑过补表迁移的存量库
    db.exec("DROP TABLE restart_pending_resumes");

    await expect(reconcileOrphans(repo, createTestLogger())).resolves.toBeUndefined();

    // 核心：消息必须到达 failed 终态（带 notice），不能因 claim 失败残留 streaming
    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("failed");
    expect(stored?.segments.some(seg => seg.body.includes("[服务重启，发言中断]"))).toBe(true);
    // turn 关闭不变量同样保持
    const history = await repo.getTurnHistory("conv-1");
    expect(history.every(t => t.turn.status === "closed")).toBe(true);
  });
});
