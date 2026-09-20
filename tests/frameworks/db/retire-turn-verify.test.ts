/**
 * F20260920trrt 复检处置验证：retireTurnSystem 对三种库形态的正确性。
 * - A 新库：历史 ALTER 补丁删除后不再注入僵尸 turn 列
 * - B 存量库：executions 悬空 FK / linked_resources turn 戳 / participants turn 列 / entries turn_id 全清 + 数据保留 + 幂等
 */
// lint-tests:allow-ddl —— 迁移测试需手工补建旧 schema 的表（模拟存量库形态——executions 带 turns FK / participants 带 turn 列等历史表形）
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "@frameworks/db/schema";
import { migrateDatabase } from "@frameworks/db/migration";
import { createTestLogger } from "../../helpers/logger";

const log = createTestLogger();

describe("retireTurnSystem 复检处置验证（F20260920trrt）", () => {
  it("A. 新库完整 bootstrap：participants 零 turn 僵尸列，turns 表不存在", () => {
    const db = new Database(":memory:");
    initSchema(db);
    migrateDatabase(db, log);
    const cols = (db.prepare("PRAGMA table_info(conversation_participants)").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols.filter(c => c.includes("turn"))).toEqual([]);
    const turns = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turns'").all();
    expect(turns).toEqual([]);
    db.close();
  });

  it("B. 存量库：executions 悬空 FK 修复 + turn 戳全清 + 数据保留 + 幂等", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    // 构造存量形态（#654 时代 executions + idnw 时代 participants/linked_resources + ctlv 时代 entries）
    db.pragma("foreign_keys = OFF");
    db.exec(`DROP TABLE scheduled_task_executions`);
    db.exec(`CREATE TABLE scheduled_task_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      triggered_at TEXT NOT NULL, completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','skipped')),
      error_message TEXT, message_id TEXT, turn_id TEXT REFERENCES turns(id))`);
    db.exec(`CREATE TABLE turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT)`);
    db.exec(`DROP TABLE entries`);
    db.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence_num INTEGER NOT NULL, entry_type TEXT, sender_type TEXT, sender_id TEXT, body TEXT, invoke_id TEXT, yield_targets TEXT, turn_id TEXT NOT NULL, status TEXT, source TEXT, metadata TEXT, sender_name TEXT, context_tokens INTEGER, context_tokens_max INTEGER, created_at TEXT, completed_at TEXT)`);
    db.exec(`DROP TABLE conversation_participants`);
    db.exec(`CREATE TABLE conversation_participants (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, otter_id TEXT NOT NULL, joined_at_turn_id TEXT, joined_at_turn_number INTEGER DEFAULT 0, left_at_turn_id TEXT, left_at_turn_number INTEGER, status TEXT DEFAULT 'active', created_at TEXT, left_at TEXT, last_read_turn_number INTEGER DEFAULT 0, last_active_turn_number INTEGER DEFAULT 0, last_read_seq INTEGER)`);
    db.exec(`DROP TABLE linked_resources`);
    db.exec(`CREATE TABLE linked_resources (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, resource_type TEXT NOT NULL, url TEXT, title TEXT, content TEXT, category TEXT, user_flagged INTEGER DEFAULT 0, metadata TEXT, linked_by TEXT NOT NULL, otter_id TEXT, auto_linked INTEGER DEFAULT 0, created_at TEXT, status TEXT DEFAULT 'active', linked_at_turn_number INTEGER DEFAULT 0, status_changed_at_turn_number INTEGER DEFAULT 0, group_id TEXT, superseded_by TEXT)`);
    // 种子
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1','t','2026-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('o1','A','big','active','2026-01-01')").run();
    db.prepare("INSERT INTO scheduled_tasks (id, conversation_id, name, cron, body, talking_stone_passed_to, sender_id, timezone, created_at, updated_at) VALUES ('t1','c1','任务','0 9 * * *','x','[]','o1','Asia/Shanghai','2026-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO turns (id, conversation_id, turn_number) VALUES ('tn1','c1',1)").run();
    db.prepare("INSERT INTO entries (id, conversation_id, sequence_num, entry_type, sender_type, sender_id, body, turn_id, status, sender_name, created_at) VALUES ('e1','c1',1,'speak','otter','o1','hi','tn1','completed','A','2026-01-01')").run();
    db.prepare("INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq, last_read_turn_number, last_active_turn_number) VALUES ('p1','c1','o1','active','2026-01-01',5,3,2)").run();
    db.prepare("INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status, turn_id) VALUES ('x1','t1','2026-01-01','completed','tn1')").run();
    db.prepare("INSERT INTO linked_resources (id, conversation_id, resource_type, url, linked_by, created_at, status, linked_at_turn_number, status_changed_at_turn_number) VALUES ('r1','c1','url','https://x','o1','2026-01-01','active',7,7)").run();
    db.pragma("foreign_keys = ON");

    migrateDatabase(db, log);

    // turns 已 drop
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turns'").all()).toEqual([]);
    // executions INSERT 不炸（复检发现 1 核心：turn_id FK 悬空场景）+ 存量保留
    db.prepare("INSERT INTO scheduled_task_executions (id, task_id, triggered_at, status) VALUES ('x2','t1','2026-01-02','completed')").run();
    expect(db.prepare("SELECT COUNT(*) c FROM scheduled_task_executions WHERE id IN ('x1','x2')").get()).toEqual({ c: 2 });
    // linked_resources turn 戳已删 + 存量保留
    const lrc = (db.prepare("PRAGMA table_info(linked_resources)").all() as Array<{ name: string }>).map(c => c.name);
    expect(lrc).not.toContain("linked_at_turn_number");
    expect(db.prepare("SELECT COUNT(*) c FROM linked_resources WHERE id='r1'").get()).toEqual({ c: 1 });
    // participants turn 列已删 + last_read_seq 保留
    const pc = (db.prepare("PRAGMA table_info(conversation_participants)").all() as Array<{ name: string }>).map(c => c.name);
    expect(pc.filter(c => c.includes("turn"))).toEqual([]);
    expect(db.prepare("SELECT last_read_seq FROM conversation_participants WHERE id='p1'").get()).toEqual({ last_read_seq: 5 });
    // entries turn_id 已删 + 存量保留
    const ec = (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map(c => c.name);
    expect(ec).not.toContain("turn_id");
    expect(db.prepare("SELECT COUNT(*) c FROM entries WHERE id='e1'").get()).toEqual({ c: 1 });
    // 幂等重跑零副作用
    migrateDatabase(db, log);
    expect(db.prepare("SELECT COUNT(*) c FROM entries").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM scheduled_task_executions").get()).toEqual({ c: 2 });
    db.close();
  });
});
