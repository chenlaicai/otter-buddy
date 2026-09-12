/**
 * reconcileOrphans 兜底清理测试（真 sqlite）。
 *
 * F20260910ctlv 批4c：messages 表 drop——failInFlightMessages 退役，invoke 侧由
 * failRunningInvokes（bootstrap）接管。本测试锁定 closeOrphanedTurns 新判据：
 * open turn = 该 turn 下有 running invoke（经 entries.turn_id 关联）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { reconcileOrphans } from "@usecases/conversation/reconcile-orphans";
import type { Conversation, Turn } from "@entities/conversation/conversation";
import type { Invoke } from "@entities/conversation/invoke";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

let db: Database.Database;
let repo: SqliteConversationRepository;
let otterRepo: SqliteOtterRepository;

beforeEach(() => {
  db = createTestDb();
  repo = new SqliteConversationRepository(db);
  const conv: Conversation = {
    id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false,
    workspaceDir: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null, archivedAt: null,
  };
  repo.create(conv);
  const turn: Turn = {
    id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
    createdAt: "2026-01-01T00:00:00Z", closedAt: null,
  };
  repo.createTurn(turn);
  otterRepo = new SqliteOtterRepository(db);
  otterRepo.createOtter({
    id: "otter-big", name: "大獭", type: "big", status: "active",
    role: null, parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
  });
});

afterEach(() => {
  db.close();
});

function invokeFixture(overrides: Partial<Invoke> = {}): Invoke {
  return {
    id: "inv-1", conversationId: "conv-1", otterId: "otter-big",
    status: "running", triggerEntryId: null,
    talkingStonePassedTo: null, startedAt: "2026-01-01T00:00:00Z", endedAt: null,
    toolCallCount: 0, tokenUsageInput: null, tokenUsageOutput: null, metadata: { turnId: "turn-1" },
    ...overrides,
  };
}

describe("reconcileOrphans 兜底清理（F20260910ctlv 批4c：invokes 判据版）", () => {
  it("无 running invoke 的 open turn 被关闭", async () => {
    await reconcileOrphans(repo, createTestLogger());

    const history = await repo.getTurnHistory("conv-1");
    expect(history.every(t => t.turn.status === "closed")).toBe(true);
  });

  it("有 running invoke（含关联 entry）的 turn 保持 open（进行中不误杀）", async () => {
    const invokeRepo = new SqliteInvokeRepository(db);
    await invokeRepo.createInvoke(invokeFixture({ status: "running" }));
    const entryRepo = new SqliteEntryRepository(db);
    await entryRepo.createEntryAtomic({
      id: "e-1", conversationId: "conv-1", sequenceNum: 0,
      entryType: "invoke_start", senderType: "otter", senderId: "otter-big",
      body: "", invokeId: "inv-1", yieldTargets: null, turnId: "turn-1",
      status: "completed", source: null, metadata: null, senderName: "otter-big",
      contextTokens: null, contextTokensMax: null,
      createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
    });

    await reconcileOrphans(repo, createTestLogger());

    const history = await repo.getTurnHistory("conv-1");
    expect(history.every(t => t.turn.status === "open")).toBe(true);
  });

  it("已结束 invoke（failed）的 turn 照常关闭", async () => {
    const invokeRepo = new SqliteInvokeRepository(db);
    await invokeRepo.createInvoke(invokeFixture({ status: "failed", endedAt: "2026-01-01T00:01:00Z" }));
    const entryRepo = new SqliteEntryRepository(db);
    await entryRepo.createEntryAtomic({
      id: "e-2", conversationId: "conv-1", sequenceNum: 0,
      entryType: "invoke_end", senderType: "otter", senderId: "otter-big",
      body: "", invokeId: "inv-1", yieldTargets: null, turnId: "turn-1",
      status: "completed", source: null, metadata: null, senderName: "otter-big",
      contextTokens: null, contextTokensMax: null,
      createdAt: "2026-01-01T00:00:01Z", completedAt: "2026-01-01T00:00:01Z",
    });

    await reconcileOrphans(repo, createTestLogger());

    const history = await repo.getTurnHistory("conv-1");
    expect(history.every(t => t.turn.status === "closed")).toBe(true);
  });
});
