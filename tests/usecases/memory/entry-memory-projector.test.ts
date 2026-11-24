import { describe, expect, it } from "vitest";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { StoreMemory } from "@usecases/memory/store-memory";
import { MemoryIndexAdapter } from "../../../src/bootstrap/memory";
import { disabledEmbeddingServices } from "../../../src/bootstrap/database";
import { decideEntryProjection, hashEntryProjectionContent } from "@usecases/memory/entry-projection-policy";
import { EntryMemoryProjector } from "@usecases/memory/entry-memory-projector";
import type { EntryProjectionInput } from "@usecases/memory/entry-projection-policy";

const NOW = "2026-11-24T00:00:00.000Z";
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456";

function input(id: string, body: string, source: "external" | null = null): EntryProjectionInput {
  return {
    entry: {
      id, conversationId: "conv-1", sequenceNum: 1, entryType: "user",
      senderType: "user", senderId: "user-1", body, invokeId: null,
      yieldTargets: null, status: "completed", source, metadata: null,
      senderName: "chen", contextTokens: null, contextTokensMax: null,
      createdAt: NOW, completedAt: NOW,
    },
    conversationKind: "normal",
    externalSpeak: false,
    attachments: [{
      id: "att-1", kind: "image", originalName: "架构图.png", mimeType: "image/png",
      sizeBytes: 2048, width: null, height: null, caption: null,
    }],
  };
}

function setup() {
  const db = createTestDb();
  db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'test', 'active', ?, ?)").run(NOW, NOW);
  const repo = new SqliteMemoryRepository(db);
  const embedding = disabledEmbeddingServices().liveService;
  const store = new StoreMemory(repo, repo, embedding, createTestLogger(), true);
  const adapter = new MemoryIndexAdapter(store, repo);
  return { db, repo, adapter };
}

describe("C2 EntryMemoryProjector 增量契约（真实 SQLite）", () => {
  it("普通 secret 经同一 decision/hash 投影，附件保留，重放不重复写向量或任务", async () => {
    const { db, repo, adapter } = setup();
    try {
      const projection = input("normal-secret", `正文 token=${SECRET}`);
      const decision = decideEntryProjection(projection);
      expect(decision.kind).toBe("project");

      await adapter.indexEntry(projection);
      const stored = db.prepare("SELECT content FROM memory_entries WHERE id = 'normal-secret'").get() as { content: string };
      expect(stored.content).toContain("[图片: 架构图.png]");
      expect(stored.content).not.toContain(SECRET);
      if (decision.kind !== "project") throw new Error("unreachable");
      expect(stored.content).toBe(decision.value.content);
      expect(hashEntryProjectionContent(stored.content)).toBe(decision.contentHash);

      const projector = new EntryMemoryProjector(repo);
      const firstReplay = projector.apply(decision, NOW);
      expect(firstReplay.kind).toBe("unchanged");
      expect(db.prepare("SELECT COUNT(*) AS n FROM embedding_tasks WHERE entry_id = 'normal-secret'").get()).toEqual({ n: 0 });

      await repo.storeEmbedding("normal-secret", new Float32Array(1024).fill(0.25));
      const secondReplay = projector.apply(decision, NOW);
      expect(secondReplay.kind).toBe("unchanged");
      expect(db.prepare("SELECT COUNT(*) AS n FROM memory_vec WHERE memory_entry_id = 'normal-secret'").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("external 增量在 policy 内 skip，memory/FTS/tasks 均为零", async () => {
    const { db, adapter } = setup();
    try {
      await adapter.indexEntry(input("external-secret", `token=${SECRET}`, "external"));
      expect(db.prepare("SELECT 1 FROM memory_entries WHERE id = 'external-secret'").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM memory_fts_jieba WHERE memory_entry_id = 'external-secret'").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM embedding_tasks WHERE entry_id = 'external-secret'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
