import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { createTestLogger } from "../../../helpers/logger";
import type { Entry } from "@entities/conversation/entry";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { initSchema } from "@frameworks/db/schema";
import { SqliteMemoryRepository } from "@frameworks/db/memory/sqlite-memory-repository";
import { SqliteProjectionOutboxRepository } from "@frameworks/db/memory/projection-outbox-repository";
import { EntryMemoryProjector, type EntryProjectionApplyResult } from "@usecases/memory/entry-memory-projector";
import { decideEntryProjection } from "@usecases/memory/entry-projection-policy";
import { EntryProjectionWorker } from "@usecases/memory/entry-projection-worker";
import {
  readEntryProjectionInput,
  readEntryProjectionInputs,
  reconcileEntryProjectionOutbox,
} from "@frameworks/db/memory/memory-projection-maintenance";
import { SendEntry } from "@usecases/conversation/send-entry";
import type { InvokeRepository } from "@usecases/conversation/invoke-repository";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { ConversationRepository } from "@usecases/conversation/conversation-repository";

const databases: Database.Database[] = [];
const NOW = "2026-11-24T00:00:00.000Z";

function db(): Database.Database {
  const value = createTestDb();
  databases.push(value);
  return value;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  vi.restoreAllMocks();
});

function seedConversation(database: Database.Database, id = "conv-1", kind: "normal" | "external" = "normal"): void {
  database.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES (?, ?, 'big', 'active', ?)")
    .run(`otter-${id}`, `Otter ${id}`, NOW);
  database.prepare("INSERT INTO conversations (id, title, status, kind, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)")
    .run(id, id, kind, NOW, NOW);
}

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    conversationId: "conv-1",
    sequenceNum: 0,
    entryType: "user",
    senderType: "user",
    senderId: "partner",
    body: `body of ${id}`,
    invokeId: null,
    yieldTargets: null,
    status: "completed",
    source: null,
    metadata: null,
    senderName: "Partner",
    contextTokens: null,
    contextTokensMax: null,
    createdAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function makeWorker(database: Database.Database, options?: {
  now?: () => Date;
  maxAttempts?: number;
  afterApply?: (result: EntryProjectionApplyResult) => void;
  onProjected?: (result: Extract<EntryProjectionApplyResult, { kind: "projected" }>) => void;
  sourceError?: string;
}) {
  const memory = new SqliteMemoryRepository(database);
  const outbox = new SqliteProjectionOutboxRepository(database);
  const worker = new EntryProjectionWorker({
    outbox,
    readSource: (task) => {
      if (options?.sourceError) throw new Error(options.sourceError);
      return readEntryProjectionInput(database, task.entryId, task.attachmentIntentIds);
    },
    projector: new EntryMemoryProjector(memory),
    onProjected: options?.onProjected ?? (() => {}),
    logger: createTestLogger(),
    now: options?.now,
    maxAttempts: options?.maxAttempts,
    afterApply: options?.afterApply,
  });
  return { worker, memory, outbox };
}

function outboxRow(database: Database.Database, id: string) {
  return database.prepare("SELECT * FROM memory_projection_outbox WHERE entry_id = ?").get(id) as {
    entry_id: string;
    status: string;
    attempts: number;
    attachment_intent_json: string;
    last_error: string | null;
  } | undefined;
}

function memoryRow(database: Database.Database, id: string) {
  return database.prepare("SELECT id, content, generation, content_hash FROM memory_entries WHERE id = ?").get(id) as {
    id: string;
    content: string;
    generation: number;
    content_hash: string;
  } | undefined;
}

describe("source projection outbox", () => {
  it("commits entry, FTS and body-free outbox atomically and requeues body changes", async () => {
    const database = db();
    seedConversation(database);
    const entries = new SqliteEntryRepository(database);
    const outbox = new SqliteProjectionOutboxRepository(database);

    await entries.createEntryAtomic(entry("user-1"), { attachmentIntentIds: ["att-1"] });
    await entries.createEntryAtomic(entry("system-1", { entryType: "system", senderType: "system" }));

    expect(outboxRow(database, "user-1")).toMatchObject({
      status: "pending",
      attempts: 0,
      attachment_intent_json: "[\"att-1\"]",
    });
    expect(outboxRow(database, "system-1")).toBeUndefined();
    expect(database.prepare("SELECT body FROM entries_fts WHERE entry_id = 'user-1'").get()).toEqual({ body: "body of user-1" });
    expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_projection_outbox'").get()).not.toMatchObject({ sql: expect.stringMatching(/\bbody\b/i) });

    outbox.markDone("user-1", NOW);
    await entries.updateEntryBody("user-1", "changed body");
    expect(outboxRow(database, "user-1")).toMatchObject({
      status: "pending", attempts: 0, attachment_intent_json: "[\"att-1\"]",
    });
  });

  it("rolls back entry and FTS when the outbox write fails", async () => {
    const database = db();
    seedConversation(database);
    const entries = new SqliteEntryRepository(database);
    database.prepare("DROP TABLE memory_projection_outbox").run();

    await expect(entries.createEntryAtomic(entry("user-1"))).rejects.toThrow(/memory_projection_outbox/);
    expect(database.prepare("SELECT COUNT(*) AS n FROM entries WHERE id = 'user-1'").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM entries_fts WHERE entry_id = 'user-1'").get()).toEqual({ n: 0 });
  });

  it("upgrades a legacy source with additive structure and a working FTS/outbox probe", async () => {
    const database = db();
    seedConversation(database);
    const entries = new SqliteEntryRepository(database);
    await entries.createEntryAtomic(entry("legacy-source"));
    database.prepare("DROP TABLE memory_projection_outbox").run();

    initSchema(database);
    initSchema(database);
    const columns = database.prepare("PRAGMA table_info(memory_projection_outbox)").all() as Array<{ name: string; pk: number }>;
    expect(columns.find((column) => column.name === "entry_id")?.pk).toBe(1);
    expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_projection_outbox'").get()).toMatchObject({
      sql: expect.stringContaining("CHECK(status IN ('pending', 'done', 'skipped', 'dead'))"),
    });
    await entries.createEntryAtomic(entry("new-source"));
    expect(outboxRow(database, "new-source")?.status).toBe("pending");
    expect(database.prepare("SELECT entry_id FROM entries_fts WHERE entries_fts MATCH 'legacy'").get()).toEqual({ entry_id: "legacy-source" });

    const { worker } = makeWorker(database);
    await worker.tickNow();
    expect(memoryRow(database, "new-source")?.content).toBe("body of new-source");
  });

  it("reconciles more than one SQL parameter batch without dropping source rows", async () => {
    const database = db();
    seedConversation(database);
    const entries = new SqliteEntryRepository(database);
    await entries.createEntries(Array.from({ length: 505 }, (_, index) => entry(`bulk-${index}`, { sequenceNum: index + 1 })));

    const inputs = readEntryProjectionInputs(database);
    expect(inputs).toHaveLength(505);
    const report = reconcileEntryProjectionOutbox(database, new Date(NOW));
    expect(report).toMatchObject({ scanned: 505, missing: 505, pending: 505 });
  });

  it("re-reads source and attachment intent instead of trusting queued content", async () => {
    const database = db();
    seedConversation(database);
    database.prepare(`INSERT INTO attachments (
      id, sha256, file_path, original_name, mime_type, kind, size_bytes, uploader_id
    ) VALUES ('att-1', 'sha', '/tmp/a.png', '架构图.png', 'image/png', 'image', 10, 'partner')`).run();
    const entries = new SqliteEntryRepository(database);
    await entries.createEntryAtomic(entry("user-1", { body: "original body" }), { attachmentIntentIds: ["att-1"] });
    database.prepare("UPDATE entries SET body = 'source body wins' WHERE id = 'user-1'").run();

    const { worker } = makeWorker(database);
    await worker.tickNow();

    expect(memoryRow(database, "user-1")?.content).toContain("source body wins");
    expect(memoryRow(database, "user-1")?.content).toContain("[图片: 架构图.png]");
    expect(outboxRow(database, "user-1")?.status).toBe("done");
  });

  it("replays an interruption after apply without advancing generation or embedding twice", async () => {
    const database = db();
    seedConversation(database);
    const entries = new SqliteEntryRepository(database);
    await entries.createEntryAtomic(entry("user-1"));
    let now = new Date("2026-11-24T00:00:00.000Z");
    let interrupted = true;
    const projected: string[] = [];
    const { worker } = makeWorker(database, {
      now: () => now,
      maxAttempts: 2,
      onProjected: (result) => projected.push(result.entryId),
      afterApply: () => {
        if (interrupted) throw new Error("interrupted before markDone");
      },
    });

    await worker.tickNow();
    expect(memoryRow(database, "user-1")?.generation).toBe(1);
    expect(outboxRow(database, "user-1")).toMatchObject({ status: "pending", attempts: 1 });

    interrupted = false;
    now = new Date("2026-11-24T00:10:00.000Z");
    await worker.tickNow();
    expect(memoryRow(database, "user-1")?.generation).toBe(1);
    expect(projected).toEqual(["user-1"]);
    expect(outboxRow(database, "user-1")?.status).toBe("done");
  });

  it("marks persistent failures dead with visible age and does not resurrect them during reconciliation", async () => {
    const database = db();
    seedConversation(database);
    const entries = new SqliteEntryRepository(database);
    await entries.createEntryAtomic(entry("user-1"));
    const now = new Date("2026-11-24T00:00:00.000Z");
    const { worker } = makeWorker(database, {
      now: () => now,
      maxAttempts: 1,
      sourceError: "permanent source read failure",
    });

    await worker.tickNow();
    expect(outboxRow(database, "user-1")).toMatchObject({ status: "dead", attempts: 1 });

    const report = reconcileEntryProjectionOutbox(database, new Date("2026-11-24T00:30:00.000Z"));
    expect(report).toMatchObject({ missing: 1, different: 0, pending: 0, dead: 1, oldestPendingAgeSeconds: null });
    expect(outboxRow(database, "user-1")?.status).toBe("dead");
  });

  it("leaves an explicit orphaned tombstone when the source entry is gone", async () => {
    const database = db();
    seedConversation(database);
    const entries = new SqliteEntryRepository(database);
    await entries.createEntryAtomic(entry("deleted-source"));
    database.prepare("DELETE FROM entries WHERE id = 'deleted-source'").run();

    const { worker } = makeWorker(database);
    await worker.tickNow();
    expect(outboxRow(database, "deleted-source")).toMatchObject({ status: "skipped", last_error: "source entry missing" });
    expect(reconcileEntryProjectionOutbox(database, new Date(NOW))).toMatchObject({
      orphaned: 1, orphanedEntryIds: ["deleted-source"],
    });
  });

  it("records external sources as skipped without creating memory artifacts", async () => {
    const database = db();
    seedConversation(database);
    seedConversation(database, "conv-external", "external");
    const entries = new SqliteEntryRepository(database);
    await entries.createEntryAtomic(entry("external-kind", { conversationId: "conv-external" }));
    await entries.createEntryAtomic(entry("external-source", { source: "external" }));

    const { worker } = makeWorker(database);
    await worker.tickNow();

    expect(outboxRow(database, "external-kind")?.status).toBe("skipped");
    expect(outboxRow(database, "external-source")?.status).toBe("skipped");
    expect(memoryRow(database, "external-kind")).toBeUndefined();
    expect(memoryRow(database, "external-source")).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS n FROM embedding_tasks WHERE entry_id IN ('external-kind', 'external-source')").get()).toEqual({ n: 0 });
  });

  it("reconciles direct writes from a compatible rollback without a watermark or duplicate generation", async () => {
    const database = db();
    seedConversation(database);
    const entries = new SqliteEntryRepository(database);
    await entries.createEntryAtomic(entry("already-projected"));
    await entries.createEntryAtomic(entry("missing-projection"));
    await entries.createEntryAtomic(entry("different-projection"));
    const memory = new SqliteMemoryRepository(database);
    const projector = new EntryMemoryProjector(memory);

    for (const [id, content] of [["already-projected", "body of already-projected"], ["different-projection", "stale direct write"]] as const) {
      const input = readEntryProjectionInput(database, id, []);
      expect(input).not.toBeNull();
      const decision = decideEntryProjection(input!);
      if (content !== "stale direct write") projector.apply(decision, NOW);
      else if (decision.kind === "project") {
        decision.value.content = content;
        projector.apply(decision, NOW);
      }
    }
    database.prepare("DELETE FROM memory_projection_outbox WHERE entry_id = 'already-projected'").run();

    const before = reconcileEntryProjectionOutbox(database, new Date(NOW));
    expect(before.missing).toBe(1);
    expect(before.different).toBe(1);
    expect(outboxRow(database, "already-projected")?.status).toBe("done");
    expect(outboxRow(database, "missing-projection")?.status).toBe("pending");
    expect(outboxRow(database, "different-projection")?.status).toBe("pending");

    const { worker } = makeWorker(database);
    await worker.tickNow();
    const after = reconcileEntryProjectionOutbox(database, new Date(NOW));
    expect(after).toMatchObject({ missing: 0, different: 0, pending: 0, dead: 0 });
    expect(memoryRow(database, "already-projected")?.generation).toBe(1);
    expect(memoryRow(database, "different-projection")?.content).toBe("body of different-projection");
    expect(memoryRow(database, "different-projection")?.generation).toBe(2);
  });

  it("reports missing, different, pending, dead and oldest pending age from the three stores", async () => {
    const database = db();
    seedConversation(database);
    const entries = new SqliteEntryRepository(database);
    await entries.createEntryAtomic(entry("pending-old"));
    await entries.createEntryAtomic(entry("dead-old"));
    database.prepare("UPDATE memory_projection_outbox SET status = 'dead', attempts = 3 WHERE entry_id = 'dead-old'").run();

    const report = reconcileEntryProjectionOutbox(database, new Date("2026-11-24T01:00:00.000Z"));
    expect(report).toMatchObject({ missing: 2, different: 0, pending: 1, dead: 1, oldestPendingAgeSeconds: 3600 });
    expect(report.missingEntryIds).toEqual(expect.arrayContaining(["pending-old", "dead-old"]));
  });

  it("SendEntry persists durable work before any memory write and the worker completes it", async () => {
    const database = db();
    seedConversation(database);
    const entryRepo = new SqliteEntryRepository(database);
    const invokeRepo = {} as InvokeRepository;
    const otterRepo = {
      getById: async (id: string) => ({ id, name: "Otter", type: "big", status: "active" }),
    } as unknown as OtterRepository;
    const conversationRepo = {
      getById: async (id: string) => ({ id, kind: "normal", status: "active" }),
    } as unknown as ConversationRepository;
    const sendEntry = new SendEntry(entryRepo, invokeRepo, otterRepo, conversationRepo, {
      logger: createTestLogger(),
    });

    const sent = await sendEntry.sendUserEntry({
      conversationId: "conv-1", senderId: "partner", body: "durable before memory", talkingStonePassedTo: [],
    });
    expect(memoryRow(database, sent.entry.id)).toBeUndefined();
    expect(outboxRow(database, sent.entry.id)?.status).toBe("pending");

    const { worker } = makeWorker(database);
    await worker.tickNow();
    expect(memoryRow(database, sent.entry.id)?.content).toBe("durable before memory");
    expect(outboxRow(database, sent.entry.id)?.status).toBe("done");
  });
});
