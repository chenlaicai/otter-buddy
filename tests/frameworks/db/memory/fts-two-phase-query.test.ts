/**
 * #1115：FTS5 两段式查询（AND 优先 / OR 兜底）的行为面回归。
 *
 * 覆盖：多词 AND 命中场景走交集（读放大收敛）、AND 空结果回落 OR（保召回）、
 * 单词条不回落（等价无额外成本）、返回结构与过滤条件不受影响。
 * 性能数字（11k→23 命中、13.7ms→2.9ms）属环境敏感断言不入单测——
 * 由特性文档实测记录承载，本文件只锁行为语义。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteMemoryRepository } from '@frameworks/db/memory/sqlite-memory-repository';

describe('#1115 FTS5 两段式查询（AND 优先 OR 兜底）', () => {
  let db: Database.Database;
  let repo: SqliteMemoryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new SqliteMemoryRepository(db);
  });
  afterEach(() => { db.close(); });

  const seed = (id: string, content: string, opts: { layer?: "working" | "historical" | "document" } = {}) =>
    repo.storeEntry({
      id,
      content,
      sourceTable: 'messages',
      sourceId: id,
      layer: opts.layer ?? 'historical',
      granularity: 'fine',
      conversationId: null,
      contentType: 'message',
      metadata: null,
      createdAt: new Date().toISOString(),
    });

  it('多词 AND 命中：交集检索（两词都出现的条目）', async () => {
    seed('e1', '方案设计与实现细节');
    seed('e2', '方案的其他内容');        // 只有「方案」
    seed('e3', '设计文档的另一个方案');  // 两词都有
    const hits = await repo.searchFTS('方案 设计', {});
    const ids = hits.map(h => h.entryId);
    expect(ids).toContain('e1');
    expect(ids).toContain('e3');
    expect(ids).not.toContain('e2'); // AND 段排除只含一词的
  });

  it('AND 空结果回落 OR：任一词出现的条目保召回', async () => {
    seed('e1', '只有方案没有另一个词');
    seed('e2', '只有检索没有别的');
    // 「方案 检索」AND 无共同条目 → OR 兜底两条都召回
    const hits = await repo.searchFTS('方案 检索', {});
    const ids = hits.map(h => h.entryId);
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
  });

  it('单词条不回落：等价查询（AND/OR 同结果），无额外成本', async () => {
    seed('e1', '獭的记忆系统');
    seed('e2', '无关内容');
    const hits = await repo.searchFTS('记忆', {});
    expect(hits.map(h => h.entryId)).toEqual(['e1']);
  });

  it('AND 段也应用 filters（layer 过滤后空结果回落 OR 也带过滤）', async () => {
    seed('e1', '方案 设计', { layer: 'historical' });
    seed('e2', '方案 设计', { layer: 'working' });
    const hits = await repo.searchFTS('方案 设计', { layer: 'working' });
    expect(hits.map(h => h.entryId)).toEqual(['e2']);
  });

  it('高亮路径共享两段式（searchFTSWithHighlight 同语义）', async () => {
    seed('e1', '方案设计与实现');
    seed('e2', '只有方案');
    const hits = await repo.searchFTSWithHighlight('方案 设计', {});
    const ids = hits.map(h => h.entryId);
    expect(ids).toContain('e1');
    expect(ids).not.toContain('e2');
  });
});
