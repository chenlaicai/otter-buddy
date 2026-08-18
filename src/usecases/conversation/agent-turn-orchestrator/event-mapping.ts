/**
 * Agent SDK 事件 → SSE 事件 / MessageEventInput 映射。
 *
 * Why: 这些是模块级纯函数（无状态、无副作用），从 agent-invoker.ts 抽取
 * 以降低编排文件体积，为 Phase 2 的 orchestrator 上提做准备。
 */

import type { AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { MessageEventInput } from "@usecases/conversation/send-message";
import type { SSEEvent } from "@contract/sse/events";

/** 从 message_end 事件提取 assistant 内容块（过滤 user/toolResult） */
export function extractAssistantContent(e: AgentStreamEvent): { type: "toolcall" | "text"; blocks: Array<Record<string, unknown>> } | null {
  const inner = (e as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
  const msg = inner ?? (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
  const role = msg?.role as string | undefined;
  const content = msg?.content as Array<Record<string, unknown>> | undefined;
  if (!content || role === "user" || role === "toolResult") return null;
  const toolCalls = content.filter((c) => c.type === "toolCall");
  if (toolCalls.length > 0) return { type: "toolcall", blocks: toolCalls };
  const textBlocks = content.filter((c) => c.type === "text");
  return textBlocks.length > 0 ? { type: "text", blocks: textBlocks } : null;
}

/** R20260810piab 遗漏 1：SDK 结构化事件 → SSE 事件映射（auto_retry / compaction，之前被丢弃） */
const SDK_EVENT_SSE_MAP: Record<string, string> = {
  auto_retry_start: "agent.retry_start",
  auto_retry_end: "agent.retry_end",
  compaction_start: "agent.compaction_start",
  compaction_end: "agent.compaction_end",
};

/** 从 SDK 事件提取结构化字段（透传到 SSE data） */
export function extractSdkEventFields(e: AgentStreamEvent): Record<string, unknown> {
  switch (e.type) {
    case "auto_retry_start":
      return { attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, errorMessage: e.errorMessage };
    case "auto_retry_end":
      return { success: e.success, attempt: e.attempt, finalError: e.finalError };
    case "compaction_start":
      return { reason: e.reason };
    case "compaction_end":
      return { reason: e.reason, aborted: e.aborted, willRetry: e.willRetry, errorMessage: e.errorMessage };
    default:
      return {};
  }
}

export function mapToSSEEvent(e: AgentStreamEvent): SSEEvent | null {
  const sseEventName = SDK_EVENT_SSE_MAP[e.type];
  if (sseEventName) {
    return { event: sseEventName, data: extractSdkEventFields(e) };
  }
  switch (e.type) {
    case "tool_execution_end":
      return { event: "tool.result", data: { toolName: e.name ?? e.toolName ?? "", result: e.result } };
    case "message_end": {
      const extracted = extractAssistantContent(e);
      if (!extracted) return null;
      const event = extracted.type === "toolcall" ? "assistant_toolcall" : "assistant_text";
      return { event, data: { content: extracted.blocks } };
    }
    case "turn_end":
      return null;
    case "agent_end":
      return { event: "agent.idle", data: {} };
    default:
      return null;
  }
}

/** 从 message_end 事件提取可存储的 MessageEventInput */
export function mapMessageEndEvent(e: AgentStreamEvent, messageId: string): MessageEventInput | null {
  const extracted = extractAssistantContent(e);
  if (!extracted) return null;
  const eventType = extracted.type === "toolcall" ? "assistant_toolcall" : "assistant_text";
  return { messageId, eventType, payload: { content: extracted.blocks } };
}

/** Pi 事件 -> MessageEventInput 映射（持久化到 DB） */
export function mapToMessageEventInput(
  e: AgentStreamEvent,
  messageId: string,
): MessageEventInput | null {
  switch (e.type) {
    case "tool_execution_end":
      return { messageId, eventType: "tool_result", payload: { name: e.name ?? e.toolName, result: e.result } };
    case "message_end":
      return mapMessageEndEvent(e, messageId);
    default:
      if (String(e.type).includes("error")) {
        return { messageId, eventType: "error", payload: { message: String(e.error ?? e.message ?? "Unknown error") } };
      }
      return null;
  }
}
