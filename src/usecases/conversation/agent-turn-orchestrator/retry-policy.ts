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
  // F20260830bsgr: bash 安全守卫命中后给 LLM 一次自纠机会（R2-1 delta 复核裁决）
  if (reason.startsWith('bash_safety:')) return true;
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

/** 构建 yield 重试的系统提醒消息（speak+yield 拆分：回合必须以 yield 交棒结束） */
export function buildYieldRetryMsg(toolCallCount?: number, hasOrphanText?: boolean): string {
  const isThinkingOnly = (toolCallCount ?? 0) === 0;
  if (hasOrphanText) {
    return "[系统提醒] 你刚才输出了一段文本，但那是**只有你自己能看到的草稿**，搭档和其他海獭都看不到。请把那段内容通过 speak(body) 重新输出，然后 yield 交棒。";
  }
  return isThinkingOnly
    ? "[系统提醒] 你上一轮没有调用任何工具。请先用 speak 输出结论，再调用 yield 交回行动权。"
    : "[系统提醒] 你上一次行动没有调用 yield 交棒就结束了。请调用 yield(to) 把行动权交给下一位。";
}

/** 构建自动重试的系统提醒消息（streaming_timeout / first_byte_timeout / circuit_break 重试时注入） */
export function buildAutoRetryMsg(reason: string): string {
  if (reason === 'streaming_timeout') {
    return '[系统提醒] 你上一轮生成过程超时，已被系统自动重试。请从中断处继续完成你的发言，不需要重新开始。';
  }
  if (reason === 'first_byte_timeout') {
    return '[系统提醒] 你上一轮模型响应超时，已被系统自动重试。请重新生成你的发言。';
  }
  if (reason.startsWith('circuit_break:')) {
    return '[系统提醒] 你上一轮工具调用异常，已被系统自动重试。请检查工具调用策略后继续。';
  }
  return '[系统提醒] 你上一轮执行异常，已被系统自动重试。请继续完成你的发言。';
}

/**
 * F20260826rsme：服务重启自动恢复的系统提醒（注入给被恢复的 otter）。
 * Why: pi session 延迟落盘（首条 assistant 消息后才写文件）可能丢失上下文尾部几步——
 * 末句引导 otter 主动查阅消息历史，把恢复质量从「依赖 session 记忆」拉到「基于可见证据续写」。
 */
export function buildRestartResumeMsg(): string {
  return '[系统提醒] 服务重启导致你的发言中断，系统已自动恢复。你之前 speak 的内容已保留在本条消息中，请基于已有进度继续完成发言，然后 yield 交棒。如果对任务上下文记忆不完整，先查阅消息历史再继续。';
}

/** F20260826rsme：恢复开始前的用户可见系统消息 */
export function buildRestartResumeSystemMsg(count: number): string {
  return `[系统] 服务重启导致 ${count} 条发言中断，正在自动恢复。`;
}

/** F20260826rsme：恢复失败/跳过时的用户可见提示 */
export function buildRestartResumeFailedMsg(reason: "invoke_error" | "skipped_concurrent"): string {
  if (reason === "skipped_concurrent") return "[系统] 检测到恢复窗口内有新消息进入，跳过自动恢复，请手动重试该消息。";
  return "[系统] 服务重启自动恢复失败，请手动重试该消息。";
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
  if (guardReason?.startsWith('bash_safety:')) return '[系统保护] 检测到危险命令（如 kill 主进程），已自动中断。请改用 otter-buddy.sh restart 或报告大獭。';
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
