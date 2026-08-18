/**
 * Retry policy functions for agent invocation.
 *
 * Why: 从 agent-invoker.ts 抽取重试决策相关纯函数，降低编排文件体积。
 * retry-policy 是纯函数+配置，无状态依赖。
 */

/** Check if guard abort reason is retryable */
export function isRetryableGuardAbort(reason: string): boolean {
  if (reason === 'degenerate_output') return false;
  if (reason === 'streaming_timeout') return true;
  if (reason === 'first_byte_timeout') return true;
  if (reason.startsWith('circuit_break:')) return true;
  return false;
}

/** 构造自动重试的过渡态消息 */
export function buildRetryFailBody(reason: string): string {
  if (reason === "streaming_timeout") return "生成过程超时";
  if (reason === "first_byte_timeout") return "模型响应超时";
  if (reason.startsWith("circuit_break:")) return "工具调用异常";
  if (reason === "api_error") return "模型服务异常";
  return "执行异常";
}

/** 构建 speak 重试的系统提醒消息 */
export function buildSpeakRetryMsg(toolCallCount?: number): string {
  const isThinkingOnly = (toolCallCount ?? 0) === 0;
  return isThinkingOnly
    ? "[系统提醒] 你上一轮没有调用任何工具。请调用 speak 结束发言。"
    : "[系统提醒] 你上一次发言没有调用 speak 就结束了。请调用 speak 结束发言。";
}

/** Build abort body: user abort vs guard abort */
export function buildGuardAbortBody(guardReason: string | undefined): string {
  if (guardReason === 'degenerate_output') return '[系统保护] 检测到输出内容异常重复，已自动中断。';
  if (guardReason === 'streaming_timeout') return '[系统保护] 生成过程超时，已自动中断。';
  if (guardReason === 'first_byte_timeout') return '[系统保护] 模型响应超时，已自动中断。';
  if (guardReason?.startsWith('circuit_break:')) {
    if (guardReason.includes('event_timeout')) return '[系统保护] 单次工具调用超时，已自动中断。';
    return '[系统保护] 检测到工具调用异常循环，已自动中断。';
  }
  return '[系统保护] 输出异常，已自动中断。';
}

/** Build user abort body with partner label */
export function buildUserAbortBody(toolCallCount: number, partnerLabel: string): string {
  return `[${partnerLabel}中断] 经过 ${toolCallCount} 次工具调用后，${partnerLabel}强制中断了当前发言。`;
}

/**
 * F20260818cbkr：熔断重启相关文案与摘要构建（纯函数）。
 * 熔断路径：orchestrator 收尾当前消息 + 上抛信号 → agent-invoker restart + 全新 invoke。
 */

/** 二次退化时当前消息的 fail 文案 */
export function buildCircuitBreakFailBody(): string {
  return "[系统] 检测到连续输出异常重复，正在熔断重启獭生";
}

/** 熔断发生时的系统消息（用户可见的自动恢复说明） */
export function buildCircuitBreakSystemMsg(): string {
  return "[系统保护] 检测到连续输出退化，已重启獭生（清空污染上下文），自动继续执行中。";
}

/** 熔断动作执行失败时的系统消息（降级：行为与现状等价，不会更糟） */
export function buildCircuitBreakFailureMsg(): string {
  return "[系统保护] 熔断重启执行失败，已中断发言，可手动重试。";
}

/** 一级熔断前情摘要（重启后作为新 session.summary 注入） */
export function buildCircuitBreakSummary(input: { originalUserMessage: string; toolNames: string[] }): string {
  const lines = [
    "[熔断重启] 上一世因连续输出退化被系统熔断，上下文已清空。",
    `当时任务：${input.originalUserMessage.slice(0, 300)}`,
    input.toolNames.length > 0
      ? `已进行到（本 turn 工具调用序列）：${input.toolNames.slice(-15).join("、")}`
      : "已进行到：本 turn 无已记录的工具调用",
    "请从中断处继续，不要重新规划。",
  ];
  return lines.join("\n");
}

/** 摘要素材查询失败时的降级短摘要 */
export function buildCircuitBreakFallbackSummary(): string {
  return "[熔断重启] 上一世因连续输出退化被系统熔断，上下文已清空。请依据对话历史继续当前任务，不要重新规划。";
}

/** 二级熔断（invoke 前预检命中）前情摘要 */
export function buildSecondaryCircuitBreakSummary(input: { lastUserMessage: string }): string {
  return [
    "[二级熔断重启] 该 otter 近期连续输出退化，系统已提前重启獭生（清空污染上下文）。",
    `当前任务：${input.lastUserMessage.slice(0, 300)}`,
    "请从中断处继续，不要重新规划。",
  ].join("\n");
}
