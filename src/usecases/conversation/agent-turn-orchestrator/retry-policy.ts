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
    ? "[系统提醒] 你上一轮没有调用任何工具。请调用 speak 结束发言——可以是你的结论，也可以是你遇到的困境。"
    : "[系统提醒] 你上一次发言没有调用 speak 工具就结束了。请调用 speak 结束发言——可以是你的结论，也可以是你遇到的困境。";
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
