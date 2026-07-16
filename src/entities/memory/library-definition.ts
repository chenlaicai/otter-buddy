/**
 * 库（Library）是记忆系统的顶层数据分区。
 * 每个库有独立的数据源表、搜索索引和检索策略。
 * 库是预定义的，不允许运行时动态创建。
 */
export interface LibraryDefinition {
  key: string;
  name: string;
  description: string;
  searchable: boolean;
  /** 全库搜索时的优先级（数值越大越优先） */
  priority: number;
}

export const LIBRARIES: LibraryDefinition[] = [
  { key: "terminology", name: "术语库", description: "项目域术语定义", searchable: true, priority: 100 },
  { key: "conversation", name: "对话库", description: "所有 session 的消息记录", searchable: true, priority: 50 },
];
