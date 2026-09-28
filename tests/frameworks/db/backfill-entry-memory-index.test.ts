/**
 * #1191 回归：entries → memory_entries 消息索引存量回填迁移。
 *
 * 锚定 backfillEntryMemoryIndex 的契约：
 * 1. user/speak 正文回填为 message 类记忆（id = entry.id，#942 ID 统一）
 * 2. system/yield/invoke_* 边界条目不入索引（旧口径）
 * 3. user 侧附件拼投影行、双侧剥 html-card 围栏
 * 4. 纯卡片消息剥离后为占位符文本（公开契约：占位符是合法内容，与增量路径同构）
 * 5. 幂等：重跑零重复
 * 6. FTS 可检索（jieba 双写）
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateDatabase } from "@frameworks/db/migration";
import { initSchema } from "@frameworks/db/schema";
import type { Logger } from "@usecases/ports/logger";

function createLogger(): Logger {
  const logs: string[] = [];
  return {
    info: (msg: string) => logs.push(msg),
    warn: (msg: string) => logs.push(msg),
    error: (msg: string) => logs.push(msg),
    debug: () => {},
    child: () => createLogger(),
  } as unknown as Logger;
}

function makeDb() {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

/** FK 前置：conversations + otters（entries 外键父行） */
function insertFkParents(db: Database.Database) {
  db.prepare("INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 't', '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z')").run();
  db.prepare("INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES ('user-1', 'chen', 'user', 'active', '2026-09-20T10:00:00Z')").run();
  db.prepare("INSERT OR IGNORE INTO otters (id, name, type, status, created_at) VALUES ('otter-1', '大獭', 'big', 'active', '2026-09-20T10:00:00Z')").run();
}

function insertEntry(db: Database.Database, id: string, type: string, body: string) {
  db.prepare(
    "INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, invoke_id, yield_targets, status, source, metadata, sender_name, context_tokens, context_tokens_max, created_at, completed_at) VALUES (?, 'conv-1', 1, ?, ?, ?, ?, NULL, NULL, 'completed', NULL, NULL, '', NULL, NULL, '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z')",
  ).run(id, type, type === "user" ? "user" : "otter", type === "user" ? "user-1" : "otter-1", body);
}

describe("#1191 backfillEntryMemoryIndex 存量回填", () => {
  it("user/speak 回填，边界条目不入，附件拼投影，纯卡片跳过，幂等", () => {
    const db = makeDb();
    const logger = createLogger();
    insertFkParents(db);

    // user 带附件
    insertEntry(db, "e-user-1", "user", "帮我把跨对话的记忆检索修好");
    db.prepare("INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, uploader_id) VALUES ('att-1', 'h1', '/tmp/a.png', '架构图.png', 'image/png', 'image', 2048, 'user-1')").run();
    db.prepare("INSERT INTO entry_attachments (entry_id, attachment_id, sequence_num) VALUES ('e-user-1', 'att-1', 0)").run();
    // speak 带卡片
    insertEntry(db, "e-speak-1", "speak", "进展汇报\n```html-card title=\"卡片\"\n<div>卡片内容不该被索引</div>\n```\n正文收尾");
    // 边界条目
    insertEntry(db, "e-system-1", "system", "系统提示不该入索引");
    insertEntry(db, "e-yield-1", "yield", "→ 交给 大獭");
    // 纯卡片（剥离后为占位符——与增量路径 StoreMemory 同构入库，占位符是公开契约）
    insertEntry(db, "e-card-1", "speak", "```html-card title=\"纯卡\"\n<div>只有卡片</div>\n```");

    migrateDatabase(db, logger);

    const rows = db.prepare("SELECT id, content_type, layer, granularity, content FROM memory_entries WHERE source_table = 'entries'").all() as Array<{ id: string; content_type: string; layer: string; granularity: string; content: string }>;
    expect(rows).toHaveLength(3); // e-user-1 + e-speak-1 + e-card-1（占位符入库，与增量路径同构）
    const user = rows.find(r => r.id === "e-user-1")!;
    expect(user.content_type).toBe("message");
    expect(user.layer).toBe("working");
    expect(user.granularity).toBe("fine");
    expect(user.content).toContain("跨对话的记忆检索修好");
    expect(user.content).toContain("[图片: 架构图.png]");
    const speak = rows.find(r => r.id === "e-speak-1")!;
    expect(speak.content).toContain("进展汇报");
    expect(speak.content).not.toContain("卡片内容不该被索引");

    // FTS 可检索（jieba 实切：「记忆」「检索」是词典词）
    const fts = db.prepare("SELECT memory_entry_id FROM memory_fts_jieba WHERE memory_fts_jieba MATCH '记忆'").all() as Array<{ memory_entry_id: string }>;
    expect(fts.map(f => f.memory_entry_id)).toContain("e-user-1");
    const fts2 = db.prepare("SELECT memory_entry_id FROM memory_fts_jieba WHERE memory_fts_jieba MATCH '检索'").all() as Array<{ memory_entry_id: string }>;
    expect(fts2.map(f => f.memory_entry_id)).toContain("e-user-1");
    // weights 全配
    const w = db.prepare("SELECT COUNT(*) AS n FROM memory_weights WHERE memory_entry_id IN ('e-user-1','e-speak-1')").get() as { n: number };
    expect(w.n).toBe(2);

    // 幂等：重跑零新增
    const before = (db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE source_table='entries'").get() as { n: number }).n;
    migrateDatabase(db, createLogger());
    const after = (db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE source_table='entries'").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
