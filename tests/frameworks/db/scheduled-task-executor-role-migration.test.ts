import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { migrateDatabase } from '@frameworks/db/migration';
import { createTestLogger } from '../../helpers/logger';

const T = '2026-10-21T01:00:00.000Z';

function oldDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  db.prepare('ALTER TABLE scheduled_tasks DROP COLUMN executor_role').run();
  db.prepare(`INSERT INTO otters (id, name, type, status, created_at) VALUES
    ('legacy-big', '大獭', 'big', 'active', ?),
    ('current-big', '大獭', 'big', 'active', ?),
    ('small-1', '小獭', 'small', 'active', ?)`).run(T, T, T);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES
    ('conv-active', 'active', ?, ?), ('conv-disabled', 'disabled-task', ?, ?)`).run(T, T, T, T);
  db.prepare(`INSERT INTO conversation_participants (id, conversation_id, otter_id, status, created_at, last_read_seq)
    VALUES ('p-current', 'conv-active', 'current-big', 'active', ?, 0)`).run(T);
  db.prepare(`INSERT INTO scheduled_tasks (
    id, conversation_id, name, schedule_type, cron, timezone, body,
    talking_stone_passed_to, sender_id, status, consecutive_failures,
    restart_before_invoke, executor_type, created_at, updated_at
  ) VALUES
    ('task-active', 'conv-active', 'active', 'cron', '0 9 * * *', 'Asia/Shanghai', 'b', '["legacy-big"]', 'legacy-big', 'active', 0, 0, 'agent', ?, ?),
    ('task-disabled', 'conv-disabled', 'disabled', 'cron', '0 9 * * *', 'Asia/Shanghai', 'b', '["small-1"]', 'system', 'disabled', 0, 0, 'agent', ?, ?)`)
    .run(T, T, T, T);
  return db;
}

describe('scheduled task executorRole 启动迁移', () => {
  it('active/disabled 全量回填；旧字段保留；sender 仅同步名册内当前大獭；幂等', () => {
    const db = oldDb();
    const logger = createTestLogger();
    migrateDatabase(db, logger);
    const rows = db.prepare(`SELECT id, executor_role, talking_stone_passed_to, sender_id FROM scheduled_tasks ORDER BY id`).all() as Array<Record<string, string>>;
    expect(rows).toEqual([
      { id: 'task-active', executor_role: '大獭', talking_stone_passed_to: '["legacy-big"]', sender_id: 'current-big' },
      { id: 'task-disabled', executor_role: '小獭', talking_stone_passed_to: '["small-1"]', sender_id: 'system' },
    ]);
    // 二次启动不回滚用户后续修改；旧字段只用于首次补列时的迁移。
    db.prepare(`UPDATE scheduled_tasks SET executor_role = '巡检角色' WHERE id = 'task-active'`).run();
    expect(() => migrateDatabase(db, logger)).not.toThrow();
    expect(db.prepare(`SELECT executor_role FROM scheduled_tasks WHERE id = 'task-active'`).get()).toEqual({ executor_role: '巡检角色' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scheduled_tasks WHERE executor_role IS NOT NULL`).get()).toEqual({ n: 2 });
    db.close();
  });

});
