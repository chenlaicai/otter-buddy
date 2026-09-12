/**
 * reconcileOrphans 防御性清理测试（真 sqlite）。
 *
 * F20260910ctlv 批4a：恢复队列分流（claimResume → ResumeInterruptedService）随
 * messages 停写退役。reconcileOrphans 保留为防御性清理——存量库万一还有旧
 * streaming 孤儿，重启时仍被置 failed（带 notice）+ 孤儿 turn 关闭。
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

let db: Database.Database;
let repo: SqliteConversationRepository;
let otterRepo: SqliteOtterRepository;

beforeEach(() => {
  db = createTestDb();
  repo = new SqliteConversationRepository(db);
  otterRepo = new SqliteOtterRepository(db);
  const conv: Conversation = {
    id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, workspaceDir: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null, archivedAt: null,
  };
  repo.create(conv);
  const turn: Turn = {
    id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
    createdAt: "2026-01-01T00:00:00Z", closedAt: null,
  };
  repo.createTurn(turn);
});

afterEach(() => {
  db.close();
});

async function seedStreamingMessage(senderId: string): Promise<string> {
  const id = crypto.randomUUID();
  const seq = ((await repo.getMaxSequenceNum("conv-1")) ?? 0) + 1;
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, sender_name, created_at)
    VALUES (?, ?, 'otter', ?, 'streaming', ?, 'turn-1', NULL, '中断獭', ?)
  `).run(id, "conv-1", senderId, seq, new Date().toISOString());
  return id;
}

describe("reconcileOrphans 防御性清理（F20260910ctlv 批4a：恢复队列退役后）", () => {
  it("存量 streaming 孤儿：置 failed（带中断 notice），不再入恢复队列", async () => {
    await otterRepo.createOtter(otterFixture());
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedStreamingMessage("otter-big");

    await reconcileOrphans(repo, createTestLogger());

    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("failed");
    expect(stored?.segments.some(seg => seg.body.includes("[服务重启，发言中断]"))).toBe(true);
  });

  it("孤儿 turn 关闭不变量保持：open = 有进行中发言", async () => {
    await otterRepo.createOtter(otterFixture());
    await repo.createParticipant(participantFixture("otter-big"));
    await seedStreamingMessage("otter-big");

    await reconcileOrphans(repo, createTestLogger());

    const history = await repo.getTurnHistory("conv-1");
    expect(history.every(t => t.turn.status === "closed")).toBe(true);
  });

  it("恢复队列表已无依赖：缺表不报错（防御性清理不中断）", async () => {
    await otterRepo.createOtter(otterFixture());
    await repo.createParticipant(participantFixture("otter-big"));
    const msgId = await seedStreamingMessage("otter-big");
    db.exec("DROP TABLE restart_pending_resumes");

    await expect(reconcileOrphans(repo, createTestLogger())).resolves.toBeUndefined();

    const stored = await repo.getMessageById(msgId);
    expect(stored?.status).toBe("failed");
  });
});
