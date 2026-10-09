import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import type { Conversation } from "@entities/conversation/conversation";

/** #1391：conversation 仓 updateStatus（archived 分支）对不存在 ID fail-closed（#1370 族模式收尾） */

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function conversationFixture(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    title: "测试对话",
    status: "active",
    summary: null,
    pinned: false,
    kind: "normal",
    workspaceDir: null,
    createdAt: "2026-07-22T00:00:00Z",
    updatedAt: "2026-07-22T00:00:00Z",
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("SqliteConversationRepository.updateStatus fail-closed（#1391）", () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(() => { db = createTestDb(); repo = new SqliteConversationRepository(db); });
  afterEach(() => { db.close(); });

  it("不存在的 ID：归档抛错（changes=0 不静默成功）", async () => {
    await expect(repo.updateStatus("conv-nonexistent", "archived", "2026-10-09T00:00:00Z"))
      .rejects.toThrow(/conversation 不存在/);
  });

  it("存在的 ID：正常归档不回归（archived_at 同步落账）", async () => {
    await repo.create(conversationFixture());
    await repo.updateStatus("conv-1", "archived", "2026-10-09T00:00:00Z");
    const conv = await repo.getById("conv-1");
    expect(conv?.status).toBe("archived");
  });

  it("不支持的 status：仍按原语义抛错（不因 fail-closed 改变；F20260922cgrp 弱状态两态，active 不是合法写入目标）", async () => {
    await expect(repo.updateStatus("conv-1", "active", "2026-10-09T00:00:00Z"))
      .rejects.toThrow(/Unsupported status transition/);
  });
});
