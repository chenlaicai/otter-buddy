/**
 * SearchQueryLogRepository：检索埋点写入 port。
 *
 * F20260826rcmm Phase 0 评估基线的数据源。
 * 只写不读——标注/统计阶段直接 SQL 查询 search_query_logs 表
 * （避免为一次性评估流程长驻读接口）。
 */

import type { SearchQueryLogInsert } from "@entities/memory/search-query-log";

export interface SearchQueryLogRepository {
  insert(log: SearchQueryLogInsert): Promise<void>;
}
