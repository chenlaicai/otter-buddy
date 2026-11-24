import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { MemoryEntry } from "@entities/memory/memory-entry";
import { migrateDatabase } from "@frameworks/db/migration";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { hashEntryProjectionContent } from "@usecases/memory/entry-projection-policy";
import { StoreMemory } from "@usecases/memory/store-memory";
import { EntryMemoryProjector } from "@usecases/memory/entry-memory-projector";
import type { ProjectionDecision } from "@usecases/memory/entry-projection-policy";
import { EmbeddingRetryWorker } from "@usecases/memory/embedding-retry-worker";
import { EmbedTimeoutError, type EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { createTestDb } from "../../../helpers/db";
import { createTestLogger } from "../../../helpers/logger";

vi.setConfig({ testTimeout: 20_000 });

function memoryEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    layer: "working",
    contentType: "message",
    sourceId: id,
    sourceTable: "entries",
    conversationId: null,
    granularity: "fine",
    content,
    metadata: null,
    createdAt: new Date().toISOString(),
  };
}

function embedding(value: number): Float32Array {
  return new Float32Array(1024).fill(value);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition did not become true");
}

function generationRow(db: Database.Database, entryId: string): {
  generation: number;
  content_hash: string;
  updated_at: string;
} | undefined {
  return db.prepare(
    "SELECT generation, content_hash, updated_at FROM memory_vec_generations WHERE entry_id = ?",
  ).get(entryId) as { generation: number; content_hash: string; updated_at: string } | undefined;
}

function taskRow(db: Database.Database, entryId: string): {
  generation: number;
  content_hash: string;
  attempts: number;
  status: string;
  last_error: string | null;
} | undefined {
  return db.prepare(
    "SELECT generation, content_hash, attempts, status, last_error FROM embedding_tasks WHERE entry_id = ?",
  ).get(entryId) as {
    generation: number;
    content_hash: string;
    attempts: number;
    status: string;
    last_error: string | null;
  } | undefined;
}

async function claimOnly(repo: SqliteMemoryRepository, entryId: string) {
  const claimed = await repo.claimPendingTasks(10);
  const task = claimed.find(candidate => candidate.entryId === entryId);
  if (!task) throw new Error(`task was not claimable: ${entryId}`);
  return task;
}

describe("memory vector generation id migration", () => {
  it("preserves generations across legacy projection id remapping", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    try {
      const old = { ...memoryEntry("legacy-id", "old content"), sourceId: "unified-id", sourceTable: "messages" };
      await repo.storeEntry(old);
      await repo.replaceEntryBySource({ ...old, content: "new content" });
      await repo.enqueueRetry("legacy-id", new Error("pending"));
      const task = await claimOnly(repo, "legacy-id");
      await repo.storeEmbedding("legacy-id", task.generation, task.contentHash, embedding(0.6));

      migrateDatabase(db, createTestLogger());

      const entry = db.prepare("SELECT generation, content_hash FROM memory_entries WHERE id = 'unified-id'").get() as {
        generation: number;
        content_hash: string;
      };
      expect(entry).toEqual({ generation: 2, content_hash: hashEntryProjectionContent("new content") });
      expect(taskRow(db, "unified-id")).toMatchObject({ generation: 2, content_hash: entry.content_hash });
      expect(generationRow(db, "unified-id")).toMatchObject({ generation: 2, content_hash: entry.content_hash });
      expect(taskRow(db, "legacy-id")).toBeUndefined();
      expect((await repo.getEmbedding("unified-id"))![0]).toBe(embedding(0.6)[0]);
    } finally {
      db.close();
    }
  });
});

describe("memory vector generation compare-and-swap", () => {
  it("keeps the newer vector and task completion when an older success arrives last", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    const worker = new EmbeddingRetryWorker(repo, repo, repo, {
      available: true,
      embed: async () => embedding(0.8),
    }, createTestLogger(), 30_000, 3);
    try {
      await repo.storeEntry(memoryEntry("entry", "old content"));
      await repo.enqueueRetry("entry", new Error("old pending"));
      const oldTask = await claimOnly(repo, "entry");

      await repo.replaceEntryBySource(memoryEntry("entry", "new content"));
      await repo.enqueueRetry("entry", new Error("new pending"));
      await worker.tickNow();
      await waitFor(() => taskRow(db, "entry") === undefined);
      expect((await repo.getEmbedding("entry"))![0]).toBe(embedding(0.8)[0]);

      await repo.storeEmbedding("entry", oldTask.generation, oldTask.contentHash, embedding(0.2));
      await repo.markTaskDone("entry", oldTask.generation, oldTask.contentHash);

      expect((await repo.getEmbedding("entry"))![0]).toBe(embedding(0.8)[0]);
      expect(generationRow(db, "entry")).toMatchObject({
        generation: 2,
        content_hash: hashEntryProjectionContent("new content"),
      });
      expect(taskRow(db, "entry")).toBeUndefined();
    } finally {
      await worker.stop();
      db.close();
    }
  });

  it("does not let an older failure mark or overwrite the newer pending task", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    try {
      await repo.storeEntry(memoryEntry("entry", "old content"));
      await repo.enqueueRetry("entry", new Error("old pending"));
      const oldTask = await claimOnly(repo, "entry");
      await repo.replaceEntryBySource(memoryEntry("entry", "new content"));
      await repo.enqueueRetry("entry", new Error("new pending"));
      const newTask = await claimOnly(repo, "entry");
      await repo.storeEmbedding("entry", newTask.generation, newTask.contentHash, embedding(0.8));
      const before = taskRow(db, "entry");

      await repo.storeEmbedding("entry", oldTask.generation, oldTask.contentHash, embedding(0.2));
      await repo.markTaskAttemptFailed("entry", oldTask.generation, oldTask.contentHash, new Error("old failure"), 1);

      expect(taskRow(db, "entry")).toEqual(before);
      expect(before).toMatchObject({ generation: 2, status: "pending", last_error: "new pending" });
      expect((await repo.getEmbedding("entry"))![0]).toBe(embedding(0.8)[0]);
    } finally {
      db.close();
    }
  });

  it("resets attempts only for a new content generation and preserves same-generation retries", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    try {
      await repo.storeEntry(memoryEntry("entry", "old content"));
      await repo.enqueueRetry("entry", new Error("old pending"));
      await claimOnly(repo, "entry");
      await repo.enqueueRetry("entry", new Error("same generation retry"));
      expect(taskRow(db, "entry")).toMatchObject({ generation: 1, attempts: 1 });

      await repo.replaceEntryBySource(memoryEntry("entry", "new content"));
      await repo.enqueueRetry("entry", new Error("new generation pending"));
      expect(taskRow(db, "entry")).toMatchObject({
        generation: 2,
        content_hash: hashEntryProjectionContent("new content"),
        attempts: 0,
        last_error: "new generation pending",
      });
    } finally {
      db.close();
    }
  });

  it("treats same-generation vector replay as idempotent and keeps unchanged content on its generation", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    try {
      await repo.storeEntry(memoryEntry("entry", "stable content"));
      await repo.enqueueRetry("entry", new Error("pending"));
      const task = await claimOnly(repo, "entry");
      await repo.storeEmbedding("entry", task.generation, task.contentHash, embedding(0.3));
      await repo.storeEmbedding("entry", task.generation, task.contentHash, embedding(0.9));
      expect((await repo.getEmbedding("entry"))![0]).toBe(embedding(0.3)[0]);

      const replaced = await repo.replaceEntryBySource(memoryEntry("entry", "stable content"));
      expect(replaced).toMatchObject({ embeddingKept: true, generation: 1, contentHash: task.contentHash });
      expect(generationRow(db, "entry")).toMatchObject({ generation: 1, content_hash: task.contentHash });
      expect((await repo.getEmbedding("entry"))![0]).toBe(embedding(0.3)[0]);
    } finally {
      db.close();
    }
  });

  it("carries projection generations through the shared projector", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    const projector = new EntryMemoryProjector(repo);
    const decision = (content: string): ProjectionDecision => ({
      kind: "project",
      value: { ...memoryEntry("entry", content), conversationId: undefined, metadata: undefined },
      contentHash: hashEntryProjectionContent(content),
      policyVersion: "test-policy",
    });
    try {
      const oldResult = projector.apply(decision("old content"), new Date().toISOString());
      const newResult = projector.apply(decision("new content"), new Date().toISOString());
      if (oldResult.kind !== "projected" || newResult.kind !== "projected") {
        throw new Error("projections should be applied");
      }
      await repo.storeEmbedding("entry", newResult.generation, newResult.contentHash, embedding(0.8));
      await repo.storeEmbedding("entry", oldResult.generation, oldResult.contentHash, embedding(0.2));

      expect(oldResult.generation).toBe(1);
      expect(newResult.generation).toBe(2);
      expect((await repo.getEmbedding("entry"))![0]).toBe(embedding(0.8)[0]);
      expect(generationRow(db, "entry")).toMatchObject({ generation: 2, content_hash: newResult.contentHash });
    } finally {
      db.close();
    }
  });

  it("binds live embedding completion to the content generation that started it", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    const pending = new Map<string, (value: Float32Array) => void>();
    const gateway: EmbeddingGateway = {
      available: true,
      embed: (content: string) => new Promise<Float32Array>(resolve => pending.set(content, resolve)),
    };
    const store = new StoreMemory(repo, repo, gateway, createTestLogger());
    try {
      await store.execute({ ...memoryEntry("entry", "old content"), conversationId: undefined, metadata: undefined });
      await store.replaceBySource({ ...memoryEntry("entry", "new content"), conversationId: undefined, metadata: undefined });
      pending.get("new content")!(embedding(0.8));
      await waitFor(() => generationRow(db, "entry")?.generation === 2);
      pending.get("old content")!(embedding(0.2));
      await new Promise(resolve => setTimeout(resolve, 30));

      expect((await repo.getEmbedding("entry"))![0]).toBe(embedding(0.8)[0]);
      expect(generationRow(db, "entry")).toMatchObject({
        generation: 2,
        content_hash: hashEntryProjectionContent("new content"),
      });
    } finally {
      db.close();
    }
  });

  it("keeps the newer vector and pending task when worker salvage arrives last", async () => {
    const db = createTestDb();
    const repo = new SqliteMemoryRepository(db);
    let salvage: ((value: Float32Array) => void) | undefined;
    const gateway: EmbeddingGateway = {
      available: true,
      embed: (_content: string, options?: { salvage?: (value: Float32Array) => void }) => {
        salvage = options?.salvage;
        return Promise.reject(new EmbedTimeoutError("late result may still arrive"));
      },
    };
    const worker = new EmbeddingRetryWorker(repo, repo, repo, gateway, createTestLogger(), 30_000, 3);
    try {
      await repo.storeEntry(memoryEntry("entry", "old content"));
      await repo.enqueueRetry("entry", new Error("old pending"));
      await worker.tickNow();
      await waitFor(() => salvage !== undefined);

      await repo.replaceEntryBySource(memoryEntry("entry", "new content"));
      await repo.enqueueRetry("entry", new Error("new pending"));
      const newTask = await claimOnly(repo, "entry");
      await repo.storeEmbedding("entry", newTask.generation, newTask.contentHash, embedding(0.8));
      const before = taskRow(db, "entry");

      salvage!(embedding(0.2));
      await new Promise(resolve => setTimeout(resolve, 30));

      expect((await repo.getEmbedding("entry"))![0]).toBe(embedding(0.8)[0]);
      expect(taskRow(db, "entry")).toEqual(before);
      expect(generationRow(db, "entry")).toMatchObject({ generation: 2, content_hash: newTask.contentHash });
    } finally {
      await worker.stop();
      db.close();
    }
  });
});
