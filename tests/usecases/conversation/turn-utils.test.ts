/**
 * tryCloseTurn 单元测试（真 sqlite）。
 * 从手写 65 方法 mock 转换为真仓库：mock 手写镜像曾导致 fake green
 * （F20260805rsto 教训），真仓库的种子/断言走同一 SQL 路径。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { tryCloseTurn } from "@usecases/conversation/turn-utils";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Conversation, Turn } from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";
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

function messageFixture(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1", conversationId: "conv-1", turnId: "turn-1",
    senderType: "user", senderId: "user-1", talkingStonePassedTo: ["otter-1"],
    status: "completed", body: "消息", sequenceNum: 1,
    contextTokens: null, contextTokensMax: null, source: "web",
    createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("tryCloseTurn（真 sqlite）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConversationRepository(db);
    await repo.create(conversationFixture());
    await repo.createTurn(turnFixture());
  });

  afterEach(() => {
    db.close();
  });

  it("所有消息到达终态时关闭 Turn", async () => {
    await repo.createCompletedMessage(messageFixture({ id: "msg-1", status: "completed" }));
    await repo.createCompletedMessage(messageFixture({ id: "msg-2", status: "failed", sequenceNum: 2 }));
    await repo.createCompletedMessage(messageFixture({ id: "msg-3", status: "aborted", sequenceNum: 3 }));

    await tryCloseTurn(repo, "turn-1");

    const turn = await repo.getTurnById("turn-1");
    expect(turn!.closedAt).not.toBeNull();
  });

  it("存在 streaming 消息时不关闭 Turn", async () => {
    await repo.createCompletedMessage(messageFixture({ id: "msg-1", status: "completed" }));
    await repo.createStreamingMessage(messageFixture({ id: "msg-2", status: "streaming", sequenceNum: 2, completedAt: null }));

    await tryCloseTurn(repo, "turn-1");

    const turn = await repo.getTurnById("turn-1");
    expect(turn!.closedAt).toBeNull();
  });

  it("无消息时关闭 Turn（空数组 every 为 true 的空真逻辑）", async () => {
    await tryCloseTurn(repo, "turn-1");

    const turn = await repo.getTurnById("turn-1");
    expect(turn!.closedAt).not.toBeNull();
  });
});
