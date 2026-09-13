// lint-tests:allow-ddl —— 迁移测试需手工补建 messages 族旧表 DDL（模拟存量库形态——生产 schema 已删除旧表，迁移函数仍须可跑）
/**
 * F20260913ctlv 收尾批4b：messages → entries 幂等回填迁移测试（真 sqlite）。
 *
 * 覆盖：无重叠直迁 / 重叠对话合并重编号+游标重映射 / yield 合成 /
 * externalIds metadata 保留 / attachments 关联 / entries_fts 回填 /
 * streaming 先置 failed / 幂等重跑零重复 / failed/aborted → metadata.invokeStatus。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { migrateDatabase, migrateMessagesToEntries } from "@frameworks/db/migration";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  ensureLegacyTables();
});

/** F20260913ctlv 批4c：新库已无 messages 族表——本测试模拟「存量库」形态：
 *  手工补建旧表 DDL（生产 schema 已删），让迁移有对象可迁。 */
function ensureLegacyTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      status TEXT NOT NULL,
      sequence_num INTEGER NOT NULL,
      turn_id TEXT,
      talking_stone_passed_to TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      metadata TEXT,
      signal_level TEXT,
      signal_meta TEXT,
      sender_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      context_tokens INTEGER,
      context_tokens_max INTEGER,
      invoke_group_id TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, body);
    CREATE TABLE IF NOT EXISTS message_attachments (
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      sequence_num INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (message_id, attachment_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS message_segments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      body TEXT NOT NULL,
      sequence_num INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
  `);
  // 幂等键也一并清掉（新库首启时标了 done 且表为空）
  db.prepare("DELETE FROM settings WHERE key = 'messages_to_entries_migrated'").run();
  db.prepare("DELETE FROM settings WHERE key = 'messages_fts_stripped_rebuild'").run();
}


afterEach(() => {
  db.close();
});

/** 直接落库一条 message（含 segments/tsp/metadata 可选） */
function seedMessage(input: {
  id: string; conversationId: string; senderType: string; senderId: string;
  status?: string; sequenceNum: number; turnId: string;
  talkingStonePassedTo?: string[] | null; body?: string;
  metadata?: string | null; senderName?: string; createdAt?: string; completedAt?: string | null;
}): void {
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num,
      turn_id, talking_stone_passed_to, source, metadata, sender_name, created_at, completed_at, context_tokens, context_tokens_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, NULL, NULL)
  `).run(
    input.id, input.conversationId, input.senderType, input.senderId,
    input.status ?? 'completed', input.sequenceNum, input.turnId,
    input.talkingStonePassedTo ? JSON.stringify(input.talkingStonePassedTo) : null,
    input.metadata ?? null, input.senderName ?? '', input.createdAt ?? '2026-01-01T00:00:00Z',
    input.completedAt ?? null,
  );
  if (input.body != null) {
    db.prepare(`
      INSERT INTO message_segments (id, message_id, body, sequence_num, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).run(`seg-${input.id}`, input.id, input.body, input.createdAt ?? '2026-01-01T00:00:00Z');
  }
}

function seedConversation(convId: string): void {
  db.prepare(`INSERT INTO conversations (id, title, status, created_at) VALUES (?, 't', 'active', '2026-01-01T00:00:00Z')`).run(convId);
  db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, status, created_at) VALUES (?, ?, 1, 'closed', '2026-01-01T00:00:00Z')`).run(`turn-${convId}`, convId);
}

/** createTestDb 已预跑 migrateDatabase（当时 messages 空、标 done）——
 *  seed 数据后需清幂等键重跑（模拟存量库首启） */
function runMigration(): void {
  db.prepare("DELETE FROM settings WHERE key = 'messages_to_entries_migrated'").run();
  db.prepare("DELETE FROM settings WHERE key = 'messages_fts_stripped_rebuild'").run();
  migrateDatabase(db, createTestLogger());
}

function getEntries(convId: string): Array<{ id: string; sequence_num: number; entry_type: string; body: string | null; yield_targets: string | null; metadata: string | null; sender_name: string }> {
  return db.prepare("SELECT id, sequence_num, entry_type, body, yield_targets, metadata, sender_name FROM entries WHERE conversation_id = ? ORDER BY sequence_num ASC").all(convId) as never;
}

describe("migrateMessagesToEntries（F20260913ctlv 批4b）", () => {
  it("无重叠对话：三类消息直迁 + tsp 映射 + seq 重排 1..N", () => {
    seedConversation("conv-1");
    seedMessage({ id: "m1", conversationId: "conv-1", senderType: "user", senderId: "chen", sequenceNum: 5, turnId: "turn-conv-1", body: "你好", talkingStonePassedTo: ["otter-a"], createdAt: "2026-01-01T00:00:01Z" });
    seedMessage({ id: "m2", conversationId: "conv-1", senderType: "otter", senderId: "otter-a", sequenceNum: 6, turnId: "turn-conv-1", body: "收到", talkingStonePassedTo: ["user"], senderName: "小獭A", createdAt: "2026-01-01T00:00:02Z", completedAt: "2026-01-01T00:00:03Z" });
    seedMessage({ id: "m3", conversationId: "conv-1", senderType: "system", senderId: "system", sequenceNum: 7, turnId: "turn-conv-1", body: "[系统] 完成", createdAt: "2026-01-01T00:00:04Z" });

    runMigration();

    const entries = getEntries("conv-1");
    // 3 条消息 + 1 条合成 yield = 4 条；seq 重排 1..4
    expect(entries.map(e => e.id)).toEqual(["m1", "m2", "m2-yield", "m3"]);
    expect(entries.map(e => e.sequence_num)).toEqual([1, 2, 3, 4]);
    expect(entries[0].entry_type).toBe("user");
    expect(entries[0].yield_targets).toBe(JSON.stringify(["otter-a"]));
    expect(entries[1].entry_type).toBe("speak");
    expect(entries[1].body).toBe("收到");
    expect(entries[1].sender_name).toBe("小獭A");
    // yield 合成行：body 约定 + senderName 保留（前端「来源 → 交给 目标」渲染依赖）
    expect(entries[2].entry_type).toBe("yield");
    expect(entries[2].body).toBe("→ 交给 user");
    expect(entries[2].yield_targets).toBe(JSON.stringify(["user"]));
    expect(entries[2].sender_name).toBe("小獭A");
    expect(entries[3].entry_type).toBe("system");
  });

  it("重叠对话：既有 entries 与新迁行合并重编号，读游标同步重映射", () => {
    seedConversation("conv-2");
    // 既有 entry（seq 1-2，时间早）
    db.prepare(`INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, invoke_id, yield_targets, turn_id, status, source, metadata, sender_name, context_tokens, context_tokens_max, created_at, completed_at)
      VALUES ('e-old-1', 'conv-2', 1, 'user', 'user', 'chen', '旧消息', NULL, NULL, 'turn-conv-2', 'completed', 'web', NULL, '', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, invoke_id, yield_targets, turn_id, status, source, metadata, sender_name, context_tokens, context_tokens_max, created_at, completed_at)
      VALUES ('e-old-2', 'conv-2', 2, 'speak', 'otter', 'otter-a', '旧回复', NULL, NULL, 'turn-conv-2', 'completed', 'web', NULL, 'A', NULL, NULL, '2026-01-01T00:00:01Z', '2026-01-01T00:00:01Z')`).run();
    // 旧消息（时间晚——按 created_at 应排在既有 entries 之后）
    seedMessage({ id: "m-new", conversationId: "conv-2", senderType: "user", senderId: "chen", sequenceNum: 1, turnId: "turn-conv-2", body: "新消息", createdAt: "2026-01-02T00:00:00Z" });
    // 读游标：读到旧 seq 1
    db.prepare(`INSERT INTO conversation_user_read_state (user_id, conversation_id, last_read_message_seq, updated_at) VALUES ('chen', 'conv-2', 1, datetime('now'))`).run();
    db.prepare(`INSERT INTO otters (id, name, type) VALUES ('otter-a', 'A', 'small')`).run();
    db.prepare(`INSERT INTO conversation_participants (id, conversation_id, otter_id, joined_at_turn_id, joined_at_turn_number, status, created_at, last_read_turn_number, last_active_turn_number, last_read_seq)
      VALUES ('p1', 'conv-2', 'otter-a', NULL, 0, 'active', '2026-01-01T00:00:00Z', 0, 0, 2)`).run();

    runMigration();

    const entries = getEntries("conv-2");
    expect(entries.map(e => e.id)).toEqual(["e-old-1", "e-old-2", "m-new"]);
    expect(entries.map(e => e.sequence_num)).toEqual([1, 2, 3]);
    // 游标重映射：旧 1（≤ 新 max 3）保留 1；participants 2 同理
    const urs = db.prepare(`SELECT last_read_message_seq FROM conversation_user_read_state WHERE user_id='chen' AND conversation_id='conv-2'`).get() as { last_read_message_seq: number };
    expect(urs.last_read_message_seq).toBe(1);
    const part = db.prepare(`SELECT last_read_seq FROM conversation_participants WHERE conversation_id='conv-2' AND otter_id='otter-a'`).get() as { last_read_seq: number };
    expect(part.last_read_seq).toBe(2);
  });

  it("failed/aborted 状态保留在 metadata.invokeStatus（entries.status 死字段全 completed）", () => {
    seedConversation("conv-3");
    seedMessage({ id: "m-f", conversationId: "conv-3", senderType: "otter", senderId: "otter-a", status: "failed", sequenceNum: 1, turnId: "turn-conv-3", body: "半截", createdAt: "2026-01-01T00:00:01Z" });
    seedMessage({ id: "m-a", conversationId: "conv-3", senderType: "otter", senderId: "otter-a", status: "aborted", sequenceNum: 2, turnId: "turn-conv-3", body: "被中断", createdAt: "2026-01-01T00:00:02Z" });

    runMigration();

    const entries = getEntries("conv-3");
    // entries.status 是死字段（全 completed，createEntry 默认值）——真实终态只在 metadata.invokeStatus
    const failedMeta = JSON.parse((entries.find(e => e.id === "m-f")!.metadata as string));
    expect(failedMeta.invokeStatus).toBe("failed");
    const abortedMeta = JSON.parse((entries.find(e => e.id === "m-a")!.metadata as string));
    expect(abortedMeta.invokeStatus).toBe("aborted");
  });

  it("streaming 残留先置 failed 再迁（reconcile 语义）", () => {
    seedConversation("conv-4");
    seedMessage({ id: "m-s", conversationId: "conv-4", senderType: "otter", senderId: "otter-a", status: "streaming", sequenceNum: 1, turnId: "turn-conv-4", body: "跑到一半", createdAt: "2026-01-01T00:00:01Z" });

    runMigration();

    // F20260913ctlv 批4c：迁移通过后旧表直接 drop——streaming 语义只体现在 entry 的 invokeStatus
    const hasMsgTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
    expect(hasMsgTable).toBeUndefined();
    const entry = getEntries("conv-4")[0];
    expect(JSON.parse(entry.metadata as string).invokeStatus).toBe("failed");
  });

  it("externalIds metadata 原样迁（招聘桥查重连续性）+ attachments 关联 + FTS 回填", () => {
    seedConversation("conv-5");
    seedMessage({
      id: "m-rec", conversationId: "conv-5", senderType: "system", senderId: "system",
      sequenceNum: 1, turnId: "turn-conv-5", body: "[招聘消息批次]",
      metadata: JSON.stringify({ externalIds: ["boss:1:m1", "boss:1:m2"] }),
      createdAt: "2026-01-01T00:00:01Z",
    });
    // 附件关联
    db.prepare(`INSERT INTO attachments (id, sha256, file_path, original_name, mime_type, kind, size_bytes, uploader_id, created_at) VALUES ('att-1', 'x', 'p/a.png', 'a.png', 'image/png', 'image', 1, 'chen', '2026-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO message_attachments (message_id, attachment_id, sequence_num) VALUES ('m-rec', 'att-1', 0)`).run();

    runMigration();

    const entry = getEntries("conv-5")[0];
    expect(JSON.parse(entry.metadata as string).externalIds).toEqual(["boss:1:m1", "boss:1:m2"]);
    const ea = db.prepare("SELECT * FROM entry_attachments WHERE entry_id = 'm-rec'").all() as Array<{ attachment_id: string }>;
    expect(ea).toHaveLength(1);
    expect(ea[0].attachment_id).toBe("att-1");
    // FTS 回填（trigram 命中）
    const fts = db.prepare("SELECT entry_id FROM entries_fts WHERE entries_fts MATCH '招聘消息'").all() as Array<{ entry_id: string }>;
    expect(fts.some(f => f.entry_id === "m-rec")).toBe(true);
  });

  it("幂等重跑：二次执行零重复（settings 键短路 + 防撞）", () => {
    seedConversation("conv-6");
    seedMessage({ id: "m1", conversationId: "conv-6", senderType: "user", senderId: "chen", sequenceNum: 1, turnId: "turn-conv-6", body: "只跑一次", createdAt: "2026-01-01T00:00:01Z" });

    runMigration();
    const count1 = (db.prepare("SELECT COUNT(*) c FROM entries WHERE conversation_id='conv-6'").get() as { c: number }).c;
    runMigration();
    const count2 = (db.prepare("SELECT COUNT(*) c FROM entries WHERE conversation_id='conv-6'").get() as { c: number }).c;
    expect(count2).toBe(count1);
    // settings 键
    const flag = db.prepare("SELECT value FROM settings WHERE key='messages_to_entries_migrated'").get() as { value: string };
    expect(flag.value).toBe("done");
  });

  it("无 messages 表（批 4c drop 后的库）：直接标 done 不炸", () => {
    db.exec("DROP TABLE messages");
    // 直接调迁移函数（migrateDatabase 其余步骤会碰 messages 列——4c 后整链退役，此处单测本函数的防御）
    expect(() => migrateMessagesToEntries(db, createTestLogger())).not.toThrow();
    const flag = db.prepare("SELECT value FROM settings WHERE key='messages_to_entries_migrated'").get() as { value: string };
    expect(flag.value).toBe("done");
  });
});
