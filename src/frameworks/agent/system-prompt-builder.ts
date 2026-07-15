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
 * 构建动态 system prompt 函数。
 *
 * 静态层（Otter 角色定义 + Skill 声明）+ 动态层（会话摘要 + 记忆检索结果）。
 * 函数在每次 LLM API 调用前执行（无缓存，R10）。
 *
 * frameworks 层只负责格式化，不做 DB 访问（CR-11 修复）。
 */
export function buildSystemPrompt(
  staticPrompt: string,
  dynamicContext?: DynamicContext,
): (ctx: unknown) => string {
  return (_ctx: unknown) => {
    const parts: string[] = [staticPrompt];

    if (dynamicContext?.sessionSummary) {
      parts.push(`## 会话摘要\n${dynamicContext.sessionSummary}`);
    }

    if (dynamicContext?.memoryRetrieval) {
      parts.push(`## 记忆检索结果\n${dynamicContext.memoryRetrieval}`);
    }

    return parts.join("\n\n");
  };
}
