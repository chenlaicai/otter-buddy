import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { stripEmptyAssistantText } from "@frameworks/agent/assistant-message-sanitizer";

/** 复刻《严重错误2》kimi-256k 中毒形态：thinking + 并行 toolCall ×2 + 空 text 尾块 */
function poisonedAssistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "查一下", thinkingSignature: "{}" },
      { type: "toolCall", id: "search_memory_0_x|fc_a", name: "search_memory", arguments: { query: "x" } },
      { type: "toolCall", id: "search_messages_1_y|fc_b", name: "search_messages", arguments: { query: "y" } },
      { type: "text", text },
    ],
    api: "openai-responses",
    provider: "kimi-256k",
    model: "k3-256k",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  } as AssistantMessage;
}

function toolResult(callId: string, name: string): ToolResultMessage {
  return { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "[]" }], isError: false, timestamp: 0 } as ToolResultMessage;
}

describe("stripEmptyAssistantText（F20261113etsan：kimi 空 text 块致 fc/output 邻接断裂 400）", () => {
  it("剥掉 toolCall 后的空 text 尾块，保留 thinking/toolCall 原序", () => {
    const poisoned = poisonedAssistant("");
    const cleaned = stripEmptyAssistantText([poisoned]);
    expect(cleaned).toBeDefined();
    const msg = cleaned![0] as AssistantMessage;
    expect(msg.content.map((b) => b.type)).toEqual(["thinking", "toolCall", "toolCall"]);
  });

  it("纯空白 text（空格/换行）同样剥除", () => {
    const cleaned = stripEmptyAssistantText([poisonedAssistant("  \n ")]);
    expect((cleaned![0] as AssistantMessage).content).toHaveLength(3);
  });

  it("无空块时返回 undefined 且原数组引用不变（零拷贝）", () => {
    const healthy = poisonedAssistant("有内容");
    const messages: Message[] = [healthy];
    expect(stripEmptyAssistantText(messages)).toBeUndefined();
  });

  it("非 assistant 消息不受影响", () => {
    const messages: Message[] = [
      { role: "user", content: "hi", timestamp: 0 } as Message,
      toolResult("search_memory_0_x|fc_a", "search_memory"),
    ];
    expect(stripEmptyAssistantText(messages)).toBeUndefined();
  });

  it("只有空 text 的 assistant 消息剥成空 content（回放层会跳过空消息）", () => {
    const msg = { ...poisonedAssistant(""), content: [{ type: "text", text: "" }] } as AssistantMessage;
    const cleaned = stripEmptyAssistantText([msg]);
    expect((cleaned![0] as AssistantMessage).content).toEqual([]);
  });

  it("混合历史：只改中毒消息，其余消息保持引用", () => {
    const user = { role: "user", content: "hi" } as Message;
    const healthy = poisonedAssistant("正常文本");
    const poisoned = poisonedAssistant("");
    const result = toolResult("search_memory_0_x|fc_a", "search_memory");
    const cleaned = stripEmptyAssistantText([user, healthy, poisoned, result]);
    expect(cleaned![0]).toBe(user);
    expect(cleaned![1]).toBe(healthy);
    expect((cleaned![2] as AssistantMessage).content).toHaveLength(3);
    expect(cleaned![3]).toBe(result);
  });

  it("openai-responses 带 textSignature 的空 text 块仍剥除（该签名是消息元数据，非思维载荷）", () => {
    const signed = {
      ...poisonedAssistant(""),
      content: [{ type: "text", text: "", textSignature: "{v:1,id,phase}" }],
    } as AssistantMessage;
    const cleaned = stripEmptyAssistantText([signed]);
    expect((cleaned![0] as AssistantMessage).content).toEqual([]);
  });

  it("非 openai-responses 的 assistant 空 text 不剥除（google 把 thoughtSignature 挂在空块上，剥掉断推理链）", () => {
    const gemini = {
      ...poisonedAssistant(""),
      api: "google-generative-ai",
      content: [{ type: "text", text: "", textSignature: "encrypted-thought-signature" }],
    } as AssistantMessage;
    expect(stripEmptyAssistantText([gemini])).toBeUndefined();
  });
});
