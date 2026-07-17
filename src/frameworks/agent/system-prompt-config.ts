/**
 * 系统提示词配置类型。
 * 类型定义在 api-contract 层（跨层共享），本文件仅导出辅助函数。
 */
export type { OtterPromptConfig, SystemReminder } from "@contract/api/otter";

/** 优先级权重（数值越小优先级越高） */
export function getPriorityWeight(priority?: "low" | "medium" | "high"): number {
  switch (priority) {
    case "high": return 0;
    case "medium": return 1;
    case "low": return 2;
    default: return 1;
  }
}
