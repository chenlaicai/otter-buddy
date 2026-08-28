/**
 * #506（F20260827mgux）：8/5 分叉点（commit 6acac0ee，PR #155 F20260805codx 引入
 * isNewDb 互斥分支）时的 schema.ts 全量表名单快照，共 28 张。
 *
 * 【实现注意】此名单是 8/5 分叉点的历史快照，不需要也不应该更新——
 * 名单语义 = 历史不可变：互斥分支引入前 initSchema 无条件跑，任何能启动的老库
 * 都拥有这 28 张表；8/5 后新增的表永远落在守卫测试的 DROP 差集中被模拟移除。
 * 新增表不需要动这个名单。
 *
 * 提取方式：git show 6acac0ee:src/frameworks/db/schema.ts | grep "CREATE TABLE IF NOT EXISTS"
 */
export const BASELINE_2026_08_05_TABLES: readonly string[] = [
  "agent_sessions",
  "connection_sessions",
  "connections",
  "conversation_otters",
  "conversation_participants",
  "conversation_user_read_state",
  "conversations",
  "features",
  "healing_events",
  "linked_resources",
  "memory_entries",
  "memory_fts",
  "memory_fts_jieba",
  "memory_vec",
  "memory_weights",
  "message_events",
  "messages",
  "messages_fts",
  "otter_context",
  "otter_sessions",
  "otters",
  "research",
  "scheduled_task_executions",
  "scheduled_tasks",
  "settings",
  "terminology_entries",
  "terminology_fts",
  "turns",
];
