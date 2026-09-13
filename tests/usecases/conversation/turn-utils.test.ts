/**
 * tryCloseTurn 单元测试（真 sqlite）。
 * 从手写 65 方法 mock 转换为真仓库：mock 手写镜像曾导致 fake green
 * （F20260805rsto 教训），真仓库的种子/断言走同一 SQL 路径。
 * F20260913ctlv 批4c：判据源 = invokes 表（messages 已 drop）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { tryCloseTurn } from "@usecases/conversation/turn-utils";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import type { Conversation, Turn } from "@entities/conversation/conversation";
import { createTestDb } from "../../helpers/db";

function conversationFixture(): Conversation {
  return {
    id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, workspaceDir: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null, archivedAt: null,
  };
}

function turnFixture(): Turn {
  return {
    id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
    createdAt: "2026-01-01T00:00:00Z", closedAt: null,
  };
}

describe("tryCloseTurn（真 sqlite，invokes 判据）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;
  let invokeRepo: SqliteInvokeRepository;
  let entryRepo: SqliteEntryRepository;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    invokeRepo = new SqliteInvokeRepository(db);
    entryRepo = new SqliteEntryRepository(db);
    await repo.create(conversationFixture());
    await repo.createTurn(turnFixture());
    const otterRepo = new SqliteOtterRepository(db);
    otterRepo.createOtter({
      id: "otter-1", name: "小獭", type: "small", status: "active",
      role: null, parentOtterId: null,
      createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  /** 种子：turn-1 下一个 invoke（经 invoke_start entry 关联） */
  async function seedInvoke(status: "running" | "completed" | "failed" | "aborted", tsp: string[] | null = null): Promise<void> {
    const id = `inv-${status}`;
    await invokeRepo.createInvoke({
      id, conversationId: "conv-1", otterId: "otter-1",
      status, triggerEntryId: null,
      talkingStonePassedTo: tsp, startedAt: "2026-01-01T00:00:00Z",
      endedAt: status === "running" ? null : "2026-01-01T00:01:00Z",
      toolCallCount: 0, tokenUsageInput: null, tokenUsageOutput: null, metadata: null,
    });
    await entryRepo.createEntryAtomic({
      id: `entry-${status}`, conversationId: "conv-1", sequenceNum: 0,
      entryType: "invoke_start", senderType: "otter", senderId: "otter-1",
      body: "", invokeId: id, yieldTargets: null, turnId: "turn-1",
      status: "completed", source: null, metadata: null, senderName: "小獭",
      contextTokens: null, contextTokensMax: null,
      createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
    });
  }

  it("无 invoke 时直接关闭 Turn（空 every 恒真语义保持）", async () => {
    const result = await tryCloseTurn(repo, "turn-1", { invokeRepo, entryRepo });
    expect(result.closed).toBe(true);
    const turn = await repo.getTurnById("turn-1");
    expect(turn!.closedAt).not.toBeNull();
  });

  it("所有 invoke 到达终态时关闭 Turn", async () => {
    await seedInvoke("completed");
    await seedInvoke("failed");

    const result = await tryCloseTurn(repo, "turn-1", { invokeRepo, entryRepo });
    expect(result.closed).toBe(true);
    const turn = await repo.getTurnById("turn-1");
    expect(turn!.closedAt).not.toBeNull();
  });

  it("有 running invoke 时不关闭 Turn", async () => {
    await seedInvoke("completed");
    await seedInvoke("running");

    const result = await tryCloseTurn(repo, "turn-1", { invokeRepo, entryRepo });
    expect(result.closed).toBe(false);
    const turn = await repo.getTurnById("turn-1");
    expect(turn!.closedAt).toBeNull();
  });

  it("终态聚合发言石：优先 yield entries 的 yieldTargets", async () => {
    await seedInvoke("completed", ["otter-9"]);
    await entryRepo.createEntryAtomic({
      id: "entry-yield", conversationId: "conv-1", sequenceNum: 0,
      entryType: "yield", senderType: "otter", senderId: "otter-1",
      body: "", invokeId: "inv-completed", yieldTargets: ["user-1"], turnId: "turn-1",
      status: "completed", source: null, metadata: null, senderName: "小獭",
      contextTokens: null, contextTokensMax: null,
      createdAt: "2026-01-01T00:02:00Z", completedAt: "2026-01-01T00:02:00Z",
    });

    const result = await tryCloseTurn(repo, "turn-1", { invokeRepo, entryRepo });
    expect(result.closed).toBe(true);
    expect(result.aggregatedTargets).toEqual(["user-1"]);
  });

  it("无 yield entry 时聚合 invoke.talkingStonePassedTo 兜底", async () => {
    await seedInvoke("completed", ["otter-9"]);

    const result = await tryCloseTurn(repo, "turn-1", { invokeRepo, entryRepo });
    expect(result.closed).toBe(true);
    expect(result.aggregatedTargets).toEqual(["otter-9"]);
  });
});
