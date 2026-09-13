/**
 * Agent SDK 事件 → SSE 事件 / MessageEventInput 映射。
 *
 * Why: 这些是模块级纯函数（无状态、无副作用），从 agent-invoker.ts 抽取
 * 以降低编排文件体积，为 Phase 2 的 orchestrator 上提做准备。
 */

import type { AgentStreamEvent } from "@usecases/ports/sdk-invoke-port";
import type { InvokeEventType } from "@entities/conversation/invoke";
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
    // F20260913ctlv：流式过程不进 SSE（从消息气泡挪出，只在 Session 弹窗展示）——
    // tool.result / assistant_text / assistant_toolcall 不再广播，仅落 invoke_events
    case "tool_execution_end":
      return null;
    case "message_end":
      return null;
    case "turn_end":
      return null;
    case "agent_end":
      return { event: "agent.idle", data: {} };
    default:
      return null;
  }
}

/** F20260913ctlv：Pi 事件 → InvokeEvent 映射（持久化到 invoke_events 表，Session 弹窗数据源）。 */
// eslint-disable-next-line complexity -- 事件类型分发表，拆分降低可读性
export function mapToInvokeEventInput(
  e: AgentStreamEvent,
): { eventType: InvokeEventType; payload: Record<string, unknown> } | null {
  switch (e.type) {
    case "tool_execution_start":
      return { eventType: "assistant_toolcall", payload: { name: e.name ?? e.toolName, arguments: (e as Record<string, unknown>).args ?? (e as Record<string, unknown>).input } };
    case "tool_execution_end": {
      const details = (e.result as { details?: Record<string, unknown> } | undefined)?.details;
      // speak 工具的落库结果单独归类（Session 弹窗里发言与工具调用分样式展示）
      if ((e.name ?? e.toolName) === "speak" && details?.__speakIntermediate === true) {
        return { eventType: "speak", payload: { body: String(details.body ?? ""), segmentId: details.segmentId, sequenceNum: details.sequenceNum } };
      }
      return { eventType: "tool_result", payload: { name: e.name ?? e.toolName, result: e.result } };
    }
    case "message_end": {
      const extracted = extractAssistantContent(e);
      if (!extracted) return null;
      const eventType: InvokeEventType = extracted.type === "toolcall" ? "assistant_toolcall" : "assistant_text";
      return { eventType, payload: { content: extracted.blocks } };
    }
    default:
      if (String(e.type).includes("error")) {
        return { eventType: "error", payload: { message: String(e.error ?? e.message ?? "Unknown error") } };
      }
      return null;
  }
}
