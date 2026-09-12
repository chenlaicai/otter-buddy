import type Database from "better-sqlite3";

/** 统计查询实现（profile 端点专用，三条独立 COUNT） */
export class SqliteStatsQuery {
  constructor(private readonly db: Database.Database) {}

  /** 獭发言数（F20260910ctlv 批4c：数据源切 entries——speak entry 即獭气泡，
   *  旧口径 message_segments JOIN messages 随 messages 表 drop 退役） */
  async getMessageCountBySender(senderId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt
      FROM entries
      WHERE entry_type = 'speak' AND sender_id = ?
    `).get(senderId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /** 名下产物数（口径：linked_resources，linked_by 匹配） */
  async getArtifactCountByLinkedBy(linkedBy: string): Promise<number> {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM linked_resources WHERE linked_by = ?"
    ).get(linkedBy) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /** 参与对话数（口径：conversation_otters，otter_id 匹配） */
  async getConversationCountByOtter(otterId: string): Promise<number> {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM conversation_otters WHERE otter_id = ?"
    ).get(otterId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}
