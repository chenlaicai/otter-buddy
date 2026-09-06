// lint-tests:allow-ddl —— 派发台账测试 seed：手工建旧格式消息/獭数据（真实投影格式，禁 mock）
/**
 * dispatch-attempt 系列测试共用的 seed helpers。
 * 从 dispatch-attempt-repo.test.ts 内联定义提取（#810 测试加入时复用），行为不变。
 */
import type Database from "better-sqlite3";

/** seed 一条已投递消息（talkingStonePassedTo JSON 列，模拟真实投影格式） */
export function seedDelivered(
  db: Database.Database,
  id: string,
  opts: {
    targets?: string[] | null;
    senderType?: string;
    senderId?: string;
    status?: string;
    conversationId?: string;
    createdAt?: string;
  } = {},
): void {
  const convId = opts.conversationId ?? "conv-1";
  const turnId = `turn-${convId}`;
  db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, 't', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z')`).run(convId);
  db.prepare(`INSERT OR IGNORE INTO turns (id, conversation_id, turn_number, created_at) VALUES (?, ?, 1, '2026-09-02T00:00:00Z')`).run(turnId, convId);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_type, sender_id, status, sequence_num, turn_id, talking_stone_passed_to, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id, convId,
    opts.senderType ?? "user",
    opts.senderId ?? "user",
    opts.status ?? "completed",
    turnId,
    opts.targets ? JSON.stringify(opts.targets) : null,
    opts.createdAt ?? "2026-09-02T09:00:00Z",
  );
}

export function seedOtter(db: Database.Database, id: string): void {
  db.prepare(`INSERT OR IGNORE INTO otters (id, name, type, created_at) VALUES (?, ?, 'big', '2026-09-02T00:00:00Z')`).run(id, `otter-${id}`);
}
