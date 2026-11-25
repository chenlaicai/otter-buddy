#!/usr/bin/env node
/** 真实文件库故障与兼容回滚演练。先构建，再以本脚本启动。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { clearTimeout, setInterval, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const childMode = process.argv[2] === "--child";
const dbPath = childMode ? process.argv[3] : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "entry-outbox-recovery-")), "drill.db");
const NOW = new Date().toISOString();
const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

const [
  { initDatabase },
  { initSchema },
  { migrateDatabase },
  { SqliteEntryRepository },
  { initRepositories },
  { createEntryProjectionWorker },
  { EntryMemoryProjector },
  { decideEntryProjection },
  { readEntryProjectionInput },
] = await Promise.all([
  import("../dist/src/frameworks/db/database.js"),
  import("../dist/src/frameworks/db/schema.js"),
  import("../dist/src/frameworks/db/migration.js"),
  import("../dist/src/frameworks/db/conversation/sqlite-entry-repository.js"),
  import("../dist/src/bootstrap/repositories.js"),
  import("../dist/src/bootstrap/memory.js"),
  import("../dist/src/usecases/memory/entry-memory-projector.js"),
  import("../dist/src/usecases/memory/entry-projection-policy.js"),
  import("../dist/src/frameworks/db/memory/memory-projection-maintenance.js"),
]);

function openDatabase() {
  const database = initDatabase({ path: dbPath, walMode: true, foreignKeys: true }, logger);
  initSchema(database, logger);
  migrateDatabase(database, logger);
  return database;
}

function seedConversation(database) {
  database.prepare("INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES ('otter-drill', 'Drill', 'big', 'active', ?)").run(NOW);
  database.prepare("INSERT OR IGNORE INTO conversations (id, title, status, kind, created_at, updated_at) VALUES ('conv-drill', 'Recovery drill', 'active', 'normal', ?, ?)").run(NOW, NOW);
}

function sourceEntry(id, body = `body of ${id}`) {
  return {
    id, conversationId: "conv-drill", sequenceNum: 0, entryType: "user",
    senderType: "user", senderId: "partner", body, invokeId: null,
    yieldTargets: null, status: "completed", source: null, metadata: null,
    senderName: "Partner", contextTokens: null, contextTokensMax: null,
    createdAt: NOW, completedAt: NOW,
  };
}

function insertRollbackSourceWithoutOutbox(database, id) {
  const item = sourceEntry(id);
  database.transaction(() => {
    database.prepare(`
      INSERT INTO entries (
        id, conversation_id, sequence_num, entry_type, sender_type, sender_id,
        body, status, sender_name, created_at, completed_at
      ) VALUES (?, ?, (SELECT COALESCE(MAX(sequence_num), 0) + 1 FROM entries WHERE conversation_id = ?), ?, ?, ?, ?, 'completed', ?, ?, ?)
    `).run(item.id, item.conversationId, item.conversationId, item.entryType, item.senderType, item.senderId, item.body, item.senderName, item.createdAt, item.completedAt);
    database.prepare("INSERT INTO entries_fts (entry_id, body) VALUES (?, ?)").run(item.id, item.body);
  })();
}

function generation(database, id) {
  return database.prepare("SELECT generation FROM memory_entries WHERE id = ?").get(id)?.generation;
}

if (childMode) {
  process.env.OTTER_EMBEDDING = "off";
  const database = openDatabase();
  seedConversation(database);
  const entries = new SqliteEntryRepository(database);
  await entries.createEntryAtomic(sourceEntry("crash-before-memory"));
  process.stdout.write(`READY:${JSON.stringify({ dbPath, entryId: "crash-before-memory" })}\n`);
  setInterval(() => {}, 60_000);
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", dbPath], {
    cwd: rootDir,
    env: { ...process.env, OTTER_EMBEDDING: "off" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not commit source in time")), 20_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("READY:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await ready;
    child.kill("SIGKILL");
    const exit = await exited;
    assert.equal(exit.signal, "SIGKILL");

    process.env.OTTER_EMBEDDING = "off";
    const database = openDatabase();
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE id = 'crash-before-memory'").get().n, 0);
      assert.equal(database.prepare("SELECT status FROM memory_projection_outbox WHERE entry_id = 'crash-before-memory'").get().status, "pending");

      const repos = initRepositories(database, logger);
      const disabledEmbedding = { available: false, embed: () => Promise.reject(new Error("embedding disabled for drill")) };
      const runtime = createEntryProjectionWorker(database, repos, disabledEmbedding, logger);
      await runtime.reconcileNow();
      assert.equal(generation(database, "crash-before-memory"), 1);
      assert.equal(database.prepare("SELECT status FROM memory_projection_outbox WHERE entry_id = 'crash-before-memory'").get().status, "done");

      insertRollbackSourceWithoutOutbox(database, "rollback-direct");
      insertRollbackSourceWithoutOutbox(database, "rollback-missing");
      const rollbackInput = readEntryProjectionInput(database, "rollback-direct", []);
      assert.ok(rollbackInput);
      const rollbackProjector = new EntryMemoryProjector(repos.entryProjection);
      rollbackProjector.apply(decideEntryProjection(rollbackInput), rollbackInput.createdAt);
      assert.equal(generation(database, "rollback-direct"), 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memory_projection_outbox WHERE entry_id IN ('rollback-direct', 'rollback-missing')").get().n, 0);

      const finalReport = await runtime.reconcileNow();
      assert.equal(finalReport.missing, 0);
      assert.equal(finalReport.different, 0);
      assert.equal(finalReport.pending, 0);
      assert.equal(finalReport.dead, 0);
      assert.equal(generation(database, "rollback-direct"), 1);
      assert.equal(generation(database, "rollback-missing"), 1);
      assert.equal(database.prepare("SELECT status FROM memory_projection_outbox WHERE entry_id = 'rollback-direct'").get().status, "done");
      assert.equal(database.prepare("SELECT status FROM memory_projection_outbox WHERE entry_id = 'rollback-missing'").get().status, "done");

      console.log(JSON.stringify({
        result: "PASS",
        database: dbPath,
        crashSignal: exit.signal,
        crashRecovery: "pending -> done without duplicate generation",
        rollback: "direct same-hash marked done; missing requeued and projected",
        finalReport,
      }, null, 2));
    } finally {
      database.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
}
