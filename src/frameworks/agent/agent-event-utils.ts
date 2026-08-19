/**
 * Agent 事件工具函数。
 *
 * 从 PiSessionFactory 拆出（D2 瘦身），职责：
 * - 从 message_end 事件提取 assistant 文本块
 * - 维护本轮 assistant 文本缓冲（speak 检测“卡片写在 speak 外”用）
 * - 创建 session 事件处理器
 */

import type { AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";

/** Agent 事件（流式推送，对齐 SDK AgentSessionEvent + 索引签名兼容弱类型访问） */
export type AgentEvent = AgentStreamEvent;

/** F20260804hcob: 从 message_end 事件提取 assistant 文本块（与 agent-invoker 的提取逻辑同构；user/toolResult 不计） */
export function extractAssistantTextFromMessageEnd(e: AgentEvent): string {
  const inner = (e as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
  const msg = inner ?? (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
  const role = msg?.role as string | undefined;
  const content = msg?.content as Array<Record<string, unknown>> | undefined;
  if (!content || role === "user" || role === "toolResult") return "";
  return content
    .filter(c => c.type === "text")
    .map(c => String(c.text ?? ""))
    .join("\n");
}

/**
 * F20260804hcob: 维护本轮 assistant 文本缓冲（speak 检测“卡片写在 speak 外”用）。
 * 缓冲按 assistant 消息隔离：message_start（role=assistant）清零，message_end 追加——
 * 检测范围收窄到“本条消息”，避免上一轮文本里的 stray 围栏误拒后续无卡 speak（甚至 livelock）。
 */
export function updateTurnText(turnText: { text: string }, e: AgentEvent): void {
  if (e.type === "message_start") {
    const msg = (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (msg?.role === "assistant") turnText.text = "";
    return;
  }
  if (e.type === "message_end") {
    const text = extractAssistantTextFromMessageEnd(e);
    if (text) turnText.text += (turnText.text ? "\n" : "") + text;
  }
}

/** 创建 session 事件处理器：跟踪工具调用 + 累积本轮 assistant 文本 + 转发事件到 onEvent 回调 */
export function createEventHandler(
  activeEntry: { abort: () => void; toolCallCount: number } | undefined,
  onEvent?: (event: AgentEvent) => void,
  turnText?: { text: string },
): (event: unknown) => void {
  return (event: unknown) => {
    const e = event as AgentEvent;
    if (e.type === "tool_execution_start" && activeEntry) {
      activeEntry.toolCallCount++;
    }
    /** F20260804hcob: message_start/end 维护本轮文本缓冲（message_end 先于本消息的工具执行触发） */
    if (turnText) updateTurnText(turnText, e);
    if (e.type !== "message_update") {
      onEvent?.(e);
    }
  };
}
