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
  // F20260831aksp T2：对话流可见文案——事实而非误导（修复前显示通用「执行异常」）
  if (reason.startsWith("bash_safety:")) return "检测到针对主进程的不允许命令，已拦截并引导海獭重新分析任务";
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

/** 构建自动重试的系统提醒消息（streaming_timeout / first_byte_timeout / circuit_break / bash_safety 重试时注入） */
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
  // F20260831aksp T2：透传拦截原因 + 无 restart 出口口径（搭档终审：不存在海獭重启主进程的合法场景）
  if (reason.startsWith('bash_safety:')) {
    return `[系统提醒] 你刚才的 bash 命令被安全守卫拦截：${reason.slice('bash_safety:'.length)} 该命令不允许：主进程是所有海獭（包括你）的运行环境，任何情况下都不得终止——你不存在需要重启或停止主进程的合法场景。若你的目的是验证代码变更：请在 worktree 中用独立端口启动隔离实例验证；若你观察到服务异常：请报告搭档处理。请基于以上约束重新分析当前任务，调整方案继续执行，不要重复原命令。`;
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

/**
 * #613：恢复完成的用户可见终态消息（issue #613 方案 A）。
 * Why: 「正在自动恢复」发出后成功路径无终态反馈，用户不知恢复结果（#604 只覆盖失败路径）。
 * 按 conversation 汇总统计——单条恢复的消息粒度太细，用户关心的是「这次重启恢复了几条、没恢复几条」。
 *
 * 检视发现1（#617）：三分类 resumed/skipped/failed 分别统计——
 * skipped 表示 stale 数据清理或并发窗口跳过（对应消息已标记 exhausted），
 * 用户无操作可做，「请手动重试」对这类数据是误导；failed 才是真正的恢复失败，
 * 保留可重试的操作指引。
 */
export function buildRestartResumeCompletedMsg(resumed: number, skipped: number, failed: number): string {
  const parts: string[] = [];
  if (resumed > 0) parts.push(`${resumed} 条中断发言已恢复`);
  if (skipped > 0) parts.push(`${skipped} 条已跳过（过期/并发，无需处理）`);
  if (failed > 0) parts.push(`${failed} 条未能恢复（请手动重试）`);
  // 全跳过（0 恢复 0 失败）：单条表述避免「0 条中断发言已恢复」的怪味文案
  if (resumed === 0 && skipped === 0 && failed === 0) parts.push("0 条中断发言已恢复");
  return `[系统] 恢复完成：${parts.join("，")}。`;
}

/**
 * #599：恢复收尾消息（终态守卫用）。
 * Why: 恢复路径 invoke 创建的是新消息（新 messageId），prepareForRetry 复位的旧消息
 * 在链结束后不再有写入者。收尾为 failed + 明确指引，把「悬挂 streaming 等用户中断」
 * 变成「已归档 + 可在原条目上手动重试」。
 */
export function buildRestartResumeTerminalMsg(outcome: "done" | "failed"): string {
  return outcome === "done"
    ? "[系统] 恢复已完成：本条为中断前的原始发言（半截内容已保留），恢复后的内容见新发言。"
    : "[系统] 恢复未完成：本条发言已中止（半截内容已保留），可在本条上手动重试。";
}

// ─── #731：bash 守卫二拦终态自动回发控制信号（guard bounce）───

/**
 * #731：单獭 guard bounce 自动回发上限（GUARD_BOUNCE_WINDOW_MS 窗口内）。
 * 超限停止自动回发，升级上报（healing high + 会话内系统消息）。
 * 拦截是反馈信号不是断头台——但反馈被无视 N 次后必须见人。
 */
export const GUARD_BOUNCE_MAX = 3;

/**
 * #731：bounce 计数窗口（ms）——限「同时失控的自循环」；
 * 历史拦截随窗口滑出，不永久占用额度（十分钟前的教训不该堵死现在的自纠）。
 */
export const GUARD_BOUNCE_WINDOW_MS = 10 * 60 * 1000;

/**
 * #731：bounce 回发消息——复用 buildAutoRetryMsg 的四要素文案（被拦/为什么/正道/继续），
 * 前缀告知回发进度。口径与 F20260831aksp 终审一致：不提供任何 restart 出口。
 */
export function buildGuardBounceMsg(reason: string, attempt: number): string {
  const core = buildAutoRetryMsg(reason).slice('[系统提醒] '.length);
  return `[系统提醒] 你上一条发言因 bash 安全守卫拦截已中止，系统自动回发控制信号（第 ${attempt}/${GUARD_BOUNCE_MAX} 次）。${core}`;
}

/** #731：bounce 时旧消息的 fail 过渡文案（一拦 auto-retry 的 buildRetryFailBody 同族，区别在自纠已失败一次） */
export function buildGuardBounceFailBody(): string {
  return "检测到针对主进程的不允许命令（自纠重试后仍被拦），已拦截并自动回发控制信号";
}

/** #731：bounce 超限升级的会话内用户可见通知 */
export function buildGuardBounceEscalationMsg(otterName: string): string {
  return `[系统保护] ${otterName} 已连续 ${GUARD_BOUNCE_MAX} 次被 bash 守卫拦截并自动回发，仍在尝试被拦命令——已停止自动回发并中断其发言。请人工介入：排查该獭任务是否涉及进程管理，或核实守卫是否误拦。`;
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
  if (guardReason?.startsWith('bash_safety:')) return '[系统保护] 检测到针对主进程的不允许命令（主进程是海獭运行环境，任何情况下不得终止），已自动中断。若需验证代码变更请在 worktree 用独立端口启动隔离实例；服务异常请报告搭档。';
  return '[系统保护] 输出异常，已自动中断。';
}

/** Build user abort body with partner label. #752: enhanced with underlying error attribution */
export function buildUserAbortBody(
  toolCallCount: number,
  partnerLabel: string,
  underlyingError?: { kind: 'api_error'; errorMessage: string } | { kind: 'guard_abort'; guardReason: string } | { kind: 'no_yield' },
): string {
  const base = `[${partnerLabel}中断] 经过 ${toolCallCount} 次工具调用后，${partnerLabel}强制中断了当前发言。`;
  // #752：0 次工具调用 + 底层有 API 错误 → 归因到系统问题而非纯用户中断
  if (toolCallCount === 0 && underlyingError) {
    if (underlyingError.kind === 'api_error') {
      const isRateLimit = /429|rate.?limit|too many/i.test(underlyingError.errorMessage);
      const hint = isRateLimit ? '模型服务限流（429）' : '模型服务异常';
      return `[${partnerLabel}中断] 当前发言因${hint}未能开始（0 次工具调用），${partnerLabel}中断了等待。`;
    }
    if (underlyingError.kind === 'guard_abort') {
      return `[${partnerLabel}中断] 当前发言因安全守卫拦截未能开始（0 次工具调用），${partnerLabel}中断了等待。`;
    }
  }
  return base;
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
