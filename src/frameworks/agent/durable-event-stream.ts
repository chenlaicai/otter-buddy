import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { AgentEvent } from "./agent-event-utils";
import type { TokenUsage } from "@usecases/conversation/token-usage";
import type { Usage } from "@earendil-works/pi-ai";

/**
 * Adapter for the public watch contract. Partial deltas use the live document's
 * `ops` (not a private snapshot): the first view starts at its current value.
 */
export class DurableEventStream {
  private text = "";
  private thinking = "";
  private readonly startedTools = new Set<string>();
  private readonly endedEntries = new Set<string>();
  private lastToolName = "";
  lastUsage: TokenUsage = { input: 0, output: 0 };
  lastMessage: { content?: Array<Record<string, unknown>>; stopReason?: string } | undefined;

  constructor(private readonly onEvent?: (event: AgentEvent) => void, private readonly onFirstEvent?: () => void) {}

  async apply(view: ConversationView, ops: readonly unknown[] = []): Promise<void> {
    this.applyPartialOps(ops);
    for (const entry of view.entries) await this.applyEntry(entry);
  }

  async event(event: AgentEvent): Promise<void> {
    if (event.type === "tool_execution_start") this.emit(event);
    else if (event.type === "message_end") this.emit(event);
    await Promise.resolve();
  }

  /** 检视处置（PR #1783 严亟 1）：对外分发钩子——DurableSession 经此把派生事件同时喂给
   *  session 事件总线（guards）与下游消费者，保持单一事件源（watch→stream 路径）。 */
  dispatch(event: AgentEvent): void { this.emit(event); }

  private applyPartialOps(ops: readonly unknown[]): void {
    for (const raw of ops) {
      if (!Array.isArray(raw) || raw.length < 2) continue;
      const [kind, path, value] = raw;
      if (typeof path !== "string") continue;
      if (kind === "a" && typeof value === "string") {
        if (path.includes("/text")) {
          this.text += value;
          this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: value, contentIndex: 0 } });
        } else if (path.includes("/thinking")) {
          this.thinking += value;
          this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: value, contentIndex: 0 } });
        }
      }
    }
  }

  private applyEntry(entry: EntryRecord): void {
    if (this.endedEntries.has(String(entry.id))) return;
    this.endedEntries.add(String(entry.id));
    if (entry.kind === "pi.assistant") this.applyAssistant(entry);
    else if (entry.kind === "pi.tool-result") this.applyToolResult(entry);
  }

  private applyAssistant(entry: EntryRecord): void {
    const message = entry.model?.[0] as unknown as { content?: Array<Record<string, unknown>>; usage?: Usage; stopReason?: string };
    this.lastMessage = message;
    this.accumulateUsage(message.usage);
    this.emit({ type: "message_start" });
    for (const block of message.content ?? []) this.applyBlock(block);
    this.emit({ type: "message_end", message });
  }

  private applyBlock(block: Record<string, unknown>): void {
    if (block.type === "toolCall" && typeof block.id === "string" && !this.startedTools.has(block.id)) {
      this.startedTools.add(block.id);
      this.emitToolStart(block.id, block);
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.length > this.text.length) {
      this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: block.text.slice(this.text.length), contentIndex: 0 } });
      this.text = block.text;
    }
  }

  private applyToolResult(entry: EntryRecord): void {
    const message = entry.model?.[0] as unknown as { toolCallId?: string; toolName?: string; content?: unknown; details?: unknown; isError?: boolean };
    this.lastToolName = message.toolName ?? this.lastToolName;
    if (message.toolCallId) this.startedTools.add(message.toolCallId);
    this.emit({ type: "tool_execution_end", toolCallId: message.toolCallId, toolName: message.toolName, result: { content: message.content ?? [], details: message.details }, isError: message.isError });
  }

  private emitToolStart(id: string, block: Record<string, unknown>): void {
    const name = typeof block.name === "string" ? block.name : "";
    this.lastToolName = name;
    const args = (block.arguments ?? {}) as Record<string, unknown>;
    this.emit({ type: "tool_call", toolCallId: id, toolName: name, input: args });
    this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
  }

  private accumulateUsage(usage: Usage | undefined): void {
    if (!usage) return;
    this.lastUsage = {
      input: (this.lastUsage.input ?? 0) + usage.input,
      output: (this.lastUsage.output ?? 0) + usage.output,
      cacheRead: (this.lastUsage.cacheRead ?? 0) + usage.cacheRead,
      cacheWrite: (this.lastUsage.cacheWrite ?? 0) + usage.cacheWrite,
    };
  }

  private emit(event: AgentEvent): void {
    this.onFirstEvent?.();
    this.onEvent?.(event);
  }
}

export function contextTokensFromUsage(usage: Usage | undefined): number | undefined {
  return usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : undefined;
}
