/**
 * 动态上下文类型（由 use case 通过 invoke() 参数传入）。
 *
 * buildSystemPrompt() 已随 pi-harness-factory.ts 一起移除（F20260716sq6e 迁移）。
 * DynamicContext 保留，供 pi-session-factory.ts 和 agent-invoker.ts 使用。
 */

/** 动态上下文（由 use case 通过 invoke() 参数传入） */
export interface DynamicContext {
  memoryRetrieval?: string;
  sessionSummary?: string;
}
