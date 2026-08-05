import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteMemoryRepository } from '@frameworks/db/memory/sqlite-memory-repository';
import type { SearchFilters } from '@usecases/memory/memory-repository';
import { tokenizeWithJieba } from '@frameworks/db/jieba-tokenizer';

describe('SqliteMemoryRepository.createdAfter 时间过滤', () => {
  let db: Database.Database;
  let repo: SqliteMemoryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    repo = new SqliteMemoryRepository(db);

    // seed 3 条 memory，时间不同
    seedMemory(db, 'id-1', 'old content', '2026-01-01T00:00:00Z');
    seedMemory(db, 'id-2', 'recent content', '2026-08-01T00:00:00Z');
    seedMemory(db, 'id-3', 'today content', '2026-08-04T00:00:00Z');

    // FTS 重建（不依赖触发器）—— memory_fts 表的列是 content 不是 body
    db.prepare("DELETE FROM memory_fts").run();
    db.prepare("DELETE FROM memory_fts_jieba").run();
    for (const row of db.prepare("SELECT id, content FROM memory_entries").all() as Array<{ id: string; content: string }>) {
      db.prepare("INSERT INTO memory_fts (memory_entry_id, content) VALUES (?, ?)").run(row.id, row.content);
      db.prepare("INSERT INTO memory_fts_jieba (memory_entry_id, content) VALUES (?, ?)").run(row.id, tokenizeWithJieba(row.content));
    }
  });

  it('不带 createdAfter：返回所有命中', async () => {
    const filters: SearchFilters = {};
    const hits = await repo.searchFTS('content', filters);
    expect(hits.length).toBe(3);
  });

  it('createdAfter=2026-07-01：过滤掉 old', async () => {
    const filters: SearchFilters = { createdAfter: '2026-07-01T00:00:00Z' };
    const hits = await repo.searchFTS('content', filters);
    expect(hits.length).toBe(2);
    expect(hits.map(h => h.entryId).sort()).toEqual(['id-2', 'id-3']);
  });

  it('createdAfter=今天 0 点：只剩今天', async () => {
    const filters: SearchFilters = { createdAfter: '2026-08-04T00:00:00Z' };
    const hits = await repo.searchFTS('content', filters);
    expect(hits.length).toBe(1);
    expect(hits[0].entryId).toBe('id-3');
  });

  it('createdAfter=未来时间：返回空', async () => {
    const filters: SearchFilters = { createdAfter: '2099-01-01T00:00:00Z' };
    const hits = await repo.searchFTS('content', filters);
    expect(hits.length).toBe(0);
  });

  it('与其他 filter 叠加', async () => {
    const filters: SearchFilters = { createdAfter: '2026-08-01T00:00:00Z', conversationId: 'conv-x' };
    // conversationId=conv-x 不存在，结果为 0
    const hits = await repo.searchFTS('content', filters);
    expect(hits.length).toBe(0);
  });
});

function seedMemory(db: Database.Database, id: string, content: string, createdAt: string): void {
  db.prepare(`
    INSERT INTO memory_entries (id, layer, content_type, source_id, source_table, conversation_id, granularity, content, created_at)
    VALUES (?, 'working', 'fact', ?, 'test', NULL, 'fine', ?, ?)
  `).run(id, id, content, createdAt);
  db.prepare(`
    INSERT INTO memory_weights (memory_entry_id, retrieval_count, last_retrieved_at, user_flagged)
    VALUES (?, 0, ?, 0)
  `).run(id, createdAt);
}
