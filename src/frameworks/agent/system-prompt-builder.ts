import type { OtterPromptConfig } from "./system-prompt-config";
import { getPriorityWeight } from "./system-prompt-config";

/** AgentHarness context 的最小类型（pi-agent-core 内部类型，frameworks 层只使用 session 字段） */
export interface HarnessContext {
  session?: unknown;
  [key: string]: unknown;
}

/** 动态上下文（由 use case 通过 invoke() 参数传入） */
export interface DynamicContext {
  memoryRetrieval?: string;
  sessionSummary?: string;
}

/**
 * 构建动态 system prompt 函数（两层继承）。
 *
 * 组装顺序：平台 prompt → Otter prompt → System reminders → 动态上下文。
 * 函数在每次 LLM API 调用前执行（无缓存，R10）。
 *
 * frameworks 层只负责格式化，不做 DB 访问（CR-11 修复）。
 */
export function buildSystemPrompt(
  platformPrompt: string,
  otterConfig: OtterPromptConfig,
  dynamicContext?: DynamicContext,
): (ctx: HarnessContext) => string {
  return (_ctx: HarnessContext) => {
    const parts: string[] = [];

    /** 1. 平台级 prompt（原则/铁律，不可违背） */
    if (platformPrompt) {
      parts.push(platformPrompt);
    }

    /** 2. Otter 级 prompt（可选叠加） */
    if (otterConfig.systemPrompt) {
      parts.push(otterConfig.systemPrompt);
    }

    /** 3. System reminders（按优先级排序） */
    if (otterConfig.reminders && otterConfig.reminders.length > 0) {
      const sorted = [...otterConfig.reminders]
        .sort((a, b) => getPriorityWeight(a.priority) - getPriorityWeight(b.priority));
      for (const reminder of sorted) {
        parts.push(`<system-reminder>\n${reminder.content}\n</system-reminder>`);
      }
    }

    /** 4. 动态上下文（会话摘要 + 记忆检索） */
    if (dynamicContext?.sessionSummary) {
      parts.push(`## 会话摘要\n${dynamicContext.sessionSummary}`);
    }

    if (dynamicContext?.memoryRetrieval) {
      parts.push(`## 记忆检索结果\n${dynamicContext.memoryRetrieval}`);
    }

    return parts.join("\n\n");
  };
}
