/**
 * #906（F20260930esqu）：entries 表 (conversation_id, sequence_num) UNIQUE 索引迁移测试。
 *
 * 覆盖四类场景（任务简报设计要求 3）：
 * 1. 新库：initSchema 后索引即 UNIQUE
 * 2. 老库模拟：先建普通索引库 → 跑迁移 → 变 UNIQUE
 * 3. 幂等：跑两次不报错（第二次判存直接返回）
 * 4. 重复数据兜底：构造含重复 (conversation_id, sequence_num) 的老库 → 迁移跳过不抛错 + 告警日志
 */
import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger, createCapturingLogger } from "../../helpers/logger";

/** entries 表最小可写形态（INSERT 造数用）：FK 目标 conversations 需先插行 */
function seedConversation(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO conversations (id, title) VALUES (?, 'test')").run(id);
}

function seedEntry(db: Database.Database, conversationId: string, seq: number): void {
  db.prepare(`
    INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_name)
    VALUES (?, ?, ?, 'system', 'test')
  `).run(`entry-${conversationId}-${seq}`, conversationId, seq);
}

/** 读取 idx_entries_conversation_seq 的 unique 标志（PRAGMA index_list） */
function seqIndexUnique(db: Database.Database): boolean | undefined {
  const indexList = db.prepare("PRAGMA index_list('entries')").all() as Array<{ name: string; unique: number }>;
  return indexList.find(idx => idx.name === 'idx_entries_conversation_seq')?.unique === 1;
}

/** 构造「老库」：新库 schema 建好后，把 UNIQUE 索引降回普通索引（模拟 #906 之前的存量形态） */
function downgradeIndexToPlain(db: Database.Database): void {
  db.exec("DROP INDEX idx_entries_conversation_seq");
  db.exec("CREATE INDEX idx_entries_conversation_seq ON entries(conversation_id, sequence_num)");
}

describe("#906 entries (conversation_id, sequence_num) UNIQUE 索引迁移", () => {
  const dbs: Database.Database[] = [];
  function track(db: Database.Database): Database.Database {
    dbs.push(db);
    return db;
  }
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  it("新库：initSchema 后索引即 UNIQUE", () => {
    const db = track(new Database(":memory:"));
    db.pragma("foreign_keys = ON");
    initSchema(db, createTestLogger());

    expect(seqIndexUnique(db)).toBe(true);
  });

  it("老库模拟：普通索引库跑迁移后变 UNIQUE", () => {
    const db = track(new Database(":memory:"));
    db.pragma("foreign_keys = ON");
    initSchema(db, createTestLogger());
    downgradeIndexToPlain(db);
    expect(seqIndexUnique(db)).toBe(false); // 夹具自检：确实是普通索引

    migrateDatabase(db, createTestLogger());

    expect(seqIndexUnique(db)).toBe(true);
    // 升级后行为验证：重复 seq 插入被数据库拒绝（约束真实生效，非仅标志位）
    seedConversation(db, "conv-u");
    seedEntry(db, "conv-u", 1);
    expect(() => seedEntry(db, "conv-u", 1)).toThrow(/UNIQUE/);
  });

  it("老库模拟：含存量数据的库迁移后数据完整", () => {
    const db = track(new Database(":memory:"));
    db.pragma("foreign_keys = ON");
    initSchema(db, createTestLogger());
    downgradeIndexToPlain(db);
    seedConversation(db, "conv-d");
    seedEntry(db, "conv-d", 1);
    seedEntry(db, "conv-d", 2);

    migrateDatabase(db, createTestLogger());

    expect(seqIndexUnique(db)).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("幂等：跑两次迁移不报错，索引保持 UNIQUE", () => {
    const db = track(new Database(":memory:"));
    db.pragma("foreign_keys = ON");
    initSchema(db, createTestLogger());
    downgradeIndexToPlain(db);

    migrateDatabase(db, createTestLogger());
    expect(() => migrateDatabase(db, createTestLogger())).not.toThrow();
    expect(seqIndexUnique(db)).toBe(true);
  });

  it("重复数据兜底：含重复 (conversation_id, sequence_num) 的老库迁移跳过不抛错 + 告警日志", () => {
    const db = track(new Database(":memory:"));
    db.pragma("foreign_keys = ON");
    initSchema(db, createTestLogger());
    downgradeIndexToPlain(db);
    seedConversation(db, "conv-r");
    seedEntry(db, "conv-r", 1);
    // 普通索引下重复 seq 可写入（正是 #906 指出的防线缺口）
    db.prepare(`
      INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_name)
      VALUES ('entry-dup', 'conv-r', 1, 'system', 'test')
    `).run();

    const logger = createCapturingLogger();
    expect(() => migrateDatabase(db, logger)).not.toThrow();

    // 保留旧行为：索引仍是普通索引，未升级
    expect(seqIndexUnique(db)).toBe(false);
    // 告警日志含定位信息（conversation_id + sequence_num）
    const warn = logger.captured.warns.find(w => w.includes("[ensureEntriesConversationSeqUnique]"));
    expect(warn).toBeDefined();
    expect(warn).toContain("conv-r");
    expect(warn).toContain("sequence_num=1");
  });

  it("兜底跳过后人工清洗完成：再次启动迁移自动补上 UNIQUE（自愈闭环）", () => {
    const db = track(new Database(":memory:"));
    db.pragma("foreign_keys = ON");
    initSchema(db, createTestLogger());
    downgradeIndexToPlain(db);
    seedConversation(db, "conv-h");
    seedEntry(db, "conv-h", 1);
    db.prepare(`
      INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_name)
      VALUES ('entry-dup', 'conv-h', 1, 'system', 'test')
    `).run();
    migrateDatabase(db, createTestLogger()); // 第一次：跳过
    expect(seqIndexUnique(db)).toBe(false);

    // 人工清洗：删除重复行
    db.prepare("DELETE FROM entries WHERE id = 'entry-dup'").run();
    migrateDatabase(db, createTestLogger()); // 第二次：自愈升级

    expect(seqIndexUnique(db)).toBe(true);
  });
});
