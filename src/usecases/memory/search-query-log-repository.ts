/**
 * SearchQueryLogRepository：检索埋点写入 port。
 *
 * 评估基线的数据源。
 * 只写不读——标注/统计阶段直接 SQL 查询 search_query_logs 表
 * （避免为一次性评估流程长驻读接口）。
 */

import type { SearchQueryLogInsert } from "@entities/memory/search-query-log";

export interface SearchQueryLogRepository {
  insert(log: SearchQueryLogInsert): Promise<void>;
  /** 按对话删除埋点行（对话销毁/合规清除覆盖日志——隐私删除链的一环） */
  deleteByConversation(conversationId: string): Promise<number>;
  /** 删除超期 redacted 行（有限保留期）；metadata-only 行无正文不受约束 */
  deleteRedactedOlderThan(cutoffIso: string): Promise<number>;
}
