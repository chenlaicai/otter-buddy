/**
 * QueryMessage.expandMessage 单元测试（真 sqlite）。
 * getMessageById/getMessages 是纯委托（pass-through），按 F20260806tstr Part 4 标准删除；
 * 本文件只保留有真实逻辑的 expandMessage（方向路由 + both 合并排序 + not_found 分支）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { QueryMessage } from "@usecases/conversation/query-message";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Conversation, Turn } from "@entities/conversation/conversation";
import type { Message } from "@entities/conversation/message";
import { DomainError } from "@entities/errors";
import { createTestDb } from "../../helpers/db";

function messageFixture(overrides: Partial<Message> = {}): Message {
  const id = overrides.id ?? "msg-1";
  return {
    id, conversationId: "conv-1", turnId: "turn-1",
    senderType: "user", senderId: "user-1", talkingStonePassedTo: ["otter-1"],
    status: "completed",
    segments: overrides.segments ?? [{ id: `${id}-seg-0`, messageId: id, body: "消息内容", sequenceNum: 0, createdAt: "2026-01-01T00:00:00Z" }],
    sequenceNum: 1,
    contextTokens: null, contextTokensMax: null, source: "web",
    senderName: '',
    createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("QueryMessage.expandMessage（真 sqlite）", () => {
  let db: Database.Database;
  let qm: QueryMessage;

  /** 种子：sequenceNum 1..5 五条消息，target 居中（seq 3） */
  beforeEach(async () => {
    db = createTestDb();
    const repo = new SqliteConversationRepository(db);
    const conv: Conversation = {
      id: "conv-1", title: "测试对话", status: "active", summary: null, pinned: false, workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedAt: null, archivedAt: null,
    };
    const turn: Turn = {
      id: "turn-1", conversationId: "conv-1", turnNumber: 1, status: "open",
      createdAt: "2026-01-01T00:00:00Z", closedAt: null,
    };
    await repo.create(conv);
    await repo.createTurn(turn);
    for (let seq = 1; seq <= 5; seq++) {
      await repo.createCompletedMessage(messageFixture({
        id: seq === 3 ? "msg-target" : `msg-${seq}`,
        sequenceNum: seq,
        createdAt: `2026-01-01T00:00:0${seq}Z`,
      }));
    }
    qm = new QueryMessage(repo);
  });

  afterEach(() => {
    db.close();
  });

  it("direction=before 返回目标之前的消息（倒序：最近的在前，真实 SQL 语义）", async () => {
    const result = await qm.expandMessage("msg-target", "before", 5);

    expect(result.map((m) => m.sequenceNum)).toEqual([2, 1]);
  });

  it("direction=after 返回目标之后的消息", async () => {
    const result = await qm.expandMessage("msg-target", "after", 5);

    expect(result.map((m) => m.sequenceNum)).toEqual([4, 5]);
  });

  it("direction=both 合并 before + target + after，按 sequenceNum 升序", async () => {
    const result = await qm.expandMessage("msg-target", "both", 5);

    expect(result.map((m) => m.sequenceNum)).toEqual([1, 2, 3, 4, 5]);
  });

  it("消息不存在时抛出 not_found 错误", async () => {
    await expect(qm.expandMessage("nonexistent", "before", 5)).rejects.toThrow(DomainError);
    await expect(qm.expandMessage("nonexistent", "before", 5)).rejects.toSatisfy(
      (err: DomainError) => err.kind === "not_found",
    );
  });
});
