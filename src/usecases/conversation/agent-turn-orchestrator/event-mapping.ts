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

/** F20260914rtsp：从 message_end 事件提取 usage（invoke.tick 数据源）。
 *  防御性解析：路径兼容 e.message.usage / e.assistantMessageEvent.usage；input/output 非有限数 → null（不发射 tick）。
 *  实测验证（pi session jsonl）：totalTokens = input+output+cacheRead+cacheWrite（不含 reasoning）——优先重用，缺失时本地求和。 */
export function extractMessageEndUsage(e: AgentStreamEvent): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number } | null {
  if (e.type !== "message_end") return null;
  const inner = (e as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
  const msg = inner ?? (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead) ?? 0;
  const cacheWrite = num(usage.cacheWrite) ?? 0;
  if (input == null || output == null) return null;
  const totalTokens = num(usage.totalTokens) ?? undefined;
  return { input, output, cacheRead, cacheWrite, ...(totalTokens !== undefined && { totalTokens }) };
}

/** F20260913ctlv：Pi 事件 → InvokeEvent 映射（持久化到 invoke_events 表，Session 弹窗数据源）。 */
// eslint-disable-next-line complexity -- 事件类型分发表，拆分降低可读性
export function mapToInvokeEventInput(
  e: AgentStreamEvent,
): { eventType: InvokeEventType; payload: Record<string, unknown> } | null {
  switch (e.type) {
    /** F20260918sesp：user 消息进入模型上下文的时点（含触发 invoke 的首条 prompt +
     *  steer/followUp 注入的消费点，pi agent-session._handleAgentEvent 发射）。
     *  数据源保持纯 pi 流（搭档拍板：不自造注入事件），落库后 Session 弹窗可见
     *  「steer 插在哪」——与模型实际看到的时序一致 */
    case "message_start": {
      const msg = (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
      if (msg?.role !== "user") return null; // assistant/toolResult 的 message_start 不落库（与既有行为一致）
      const content = Array.isArray(msg.content)
        ? (msg.content as Array<Record<string, unknown>>)
            .map((c) => (typeof c?.text === "string" ? c.text : ""))
            .filter(Boolean)
            .join("\n")
        : String(msg.content ?? "");
      return { eventType: "user_injection", payload: { content, timestamp: msg.timestamp } };
    }
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
