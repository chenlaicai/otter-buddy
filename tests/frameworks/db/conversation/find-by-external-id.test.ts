import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '@frameworks/db/schema';
import { SqliteConversationRepository } from '@frameworks/db/conversation/sqlite-conversation-repository';

describe('SqliteConversationRepository.findByExternalId', () => {
  let db: Database.Database;
  let repo: SqliteConversationRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    repo = new SqliteConversationRepository(db);

    // seed：建 conversation + turn + 含 metadata 的消息
    db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run('conv-1', 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    db.prepare(`INSERT INTO turns (id, conversation_id, turn_number, status, created_at, closed_at) VALUES (?, ?, 1, 'closed', ?, ?)`)
      .run('turn-1', 'conv-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    // 含 externalId 的消息（body 已迁移至 message_segments 子表）
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, source, metadata, created_at)
      VALUES (?, ?, 'system', 'boss-bridge', 'completed', 1, ?, NULL, NULL, ?, ?)
    `).run(
      'msg-1', 'conv-1', 'turn-1',
      JSON.stringify({ externalId: 'boss:b1:m1', eventType: undefined, severity: undefined }),
      '2026-01-01T00:00:00Z',
    );
    db.prepare(`
      INSERT INTO message_segments (id, message_id, body, sequence_num, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).run('seg-msg-1', 'msg-1', '[招聘消息批次]', '2026-01-01T00:00:00Z');

    // 不含 metadata 的旧消息
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, source, metadata, created_at)
      VALUES (?, ?, 'user', 'u1', 'completed', 2, ?, NULL, 'web', NULL, ?)
    `).run('msg-2', 'conv-1', 'turn-1', '2026-01-02T00:00:00Z');
    db.prepare(`
      INSERT INTO message_segments (id, message_id, body, sequence_num, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).run('seg-msg-2', 'msg-2', 'hello', '2026-01-02T00:00:00Z');
  });

  it('externalId 存在 → 返回对应消息', async () => {
    const msg = await repo.findByExternalId('boss:b1:m1');
    expect(msg).not.toBeNull();
    expect(msg?.id).toBe('msg-1');
    expect(msg?.metadata?.externalId).toBe('boss:b1:m1');
  });

  it('externalId 不存在 → 返回 null', async () => {
    const msg = await repo.findByExternalId('boss:b1:nope');
    expect(msg).toBeNull();
  });

  it('旧消息 metadata=NULL 不影响 JSON_EXTRACT', async () => {
    // 旧消息的 metadata 是 NULL，JSON_EXTRACT 应该返回 NULL 而不是抛错
    const msg = await repo.findByExternalId('any-external-id');
    expect(msg).toBeNull();
  });
});
