import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { stripEmptyAssistantText, aggregateFragmentedToolCalls } from "@frameworks/agent/assistant-message-sanitizer";

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

describe("stripEmptyAssistantText（kimi 空 text 块致 fc/output 邻接断裂 400）", () => {
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

/** 复刻 sqlite entry 3359 真实中毒形态：bash 调用被 kimi 流式拆成 1 真 + 4 碎片 */
function fragmentedAssistant(): AssistantMessage {
  const err = (msg: string) => msg;
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I got timeout retry.", thinkingSignature: "{}" },
      {
        type: "toolCall",
        id: "bash_0_e8eeecff|fc_34te72bwy5CGccz2f26W1xGH",
        name: "bash",
        arguments: {},
        argumentsError: err("Expected property name or '}' in JSON at position 1 (line 1 column 2)\n\nReceived arguments:\n{"),
      },
      {
        type: "toolCall",
        id: "|fc_f4O7CxVjDYMSmDSiT8sBR0gt",
        name: "",
        arguments: {},
        argumentsError: err("Unexpected non-whitespace character after JSON at position 9 (line 1 column 10)\n\nReceived arguments:\n\"command\": \"grep -n"),
      },
      {
        type: "toolCall",
        id: "|fc_RarTd0aoNsCy7l6gZzEyBhCf",
        name: "",
        arguments: {},
        argumentsError: err("Unterminated string in JSON at position 1 (line 1 column 2)\n\nReceived arguments:\n\""),
      },
      {
        type: "toolCall",
        id: "|fc_Hebg4oRMrtlrsGSwGHHJonrZ",
        name: "",
        arguments: {},
        argumentsError: err("Unexpected token ',', \", \"timeout\": 120\" is not valid JSON\n\nReceived arguments:\n, \"timeout\": 120"),
      },
      {
        type: "toolCall",
        id: "|fc_EYFZfTWTwDul0Yuw8Zj0ZuJq",
        name: "",
        arguments: {},
        argumentsError: err("Unexpected token '}', \"}\" is not valid JSON\n\nReceived arguments:\n}"),
      },
    ],
    api: "openai-responses",
    provider: "kimi",
    model: "k3.1-pro",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  } as unknown as AssistantMessage;
}

/** 复刻 sqlite entry 3383 形态：多真调用交错碎片（真1+碎4+真2+碎2+真3+碎3 模式的简化版） */
function interleavedAssistant(): AssistantMessage {
  const real = (seq: string, name: string, frag: string) => ({
    type: "toolCall",
    id: `${name}_${seq}|fc_real${seq}`,
    name,
    arguments: {},
    argumentsError: `bad json\n\nReceived arguments:\n${frag}`,
  });
  const frag = (seq: string, piece: string) => ({
    type: "toolCall",
    id: `|fc_frag${seq}`,
    name: "",
    arguments: {},
    argumentsError: `bad json\n\nReceived arguments:\n${piece}`,
  });
  return {
    role: "assistant",
    content: [
      real("0", "read", `{"path": `),
      frag("a", `"docs/plan.md"`),
      frag("b", `}`),
      real("1", "read", `{"path": `),
      frag("c", `"docs/notes.md"`),
      frag("d", `}`),
      real("2", "search_memory", `{"query": `),
      frag("e", `"status"`),
      frag("f", `, "limit": 3`),
      frag("g", `}`),
    ],
    api: "openai-responses",
    provider: "kimi",
    model: "k3.1-pro",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  } as unknown as AssistantMessage;
}

describe("aggregateFragmentedToolCalls（kimi 流式拆碎 function_call 致 duplicated tool call id 400）", () => {
  it("复刻 3359：真调用 + 4 碎片聚合为完整参数，碎片消失", () => {
    const cleaned = aggregateFragmentedToolCalls([fragmentedAssistant()]);
    expect(cleaned).toBeDefined();
    const msg = cleaned![0] as AssistantMessage;
    const calls = msg.content.filter((b) => b.type === "toolCall");
    expect(calls).toHaveLength(1);
    const call = calls[0] as { id: string; name: string; arguments: Record<string, unknown>; argumentsError?: string };
    expect(call.id).toBe("bash_0_e8eeecff|fc_34te72bwy5CGccz2f26W1xGH");
    expect(call.name).toBe("bash");
    expect(call.arguments).toEqual({ command: "grep -n", timeout: 120 });
    expect(call.argumentsError).toBeUndefined();
  });

  it("复刻 3383：多真调用交错碎片，各归各真调用", () => {
    const cleaned = aggregateFragmentedToolCalls([interleavedAssistant()]);
    const msg = cleaned![0] as AssistantMessage;
    const calls = msg.content.filter((b) => b.type === "toolCall") as Array<{ id: string; arguments: Record<string, unknown> }>;
    expect(calls).toHaveLength(3);
    expect(calls[0].arguments).toEqual({ path: "docs/plan.md" });
    expect(calls[1].arguments).toEqual({ path: "docs/notes.md" });
    expect(calls[2].arguments).toEqual({ query: "status", limit: 3 });
  });

  it("孤儿 error toolResult（call_id 段空）剔除，真 toolResult 保留", () => {
    const real = toolResult("bash_0_e8eeecff|fc_34te", "bash");
    const orphan1 = toolResult("|fc_f4O7CxVjDYMSmDSiT8sBR0gt", "");
    const orphan2 = toolResult("|fc_EYFZfTWTwDul0Yuw8Zj0ZuJq", "");
    const cleaned = aggregateFragmentedToolCalls([fragmentedAssistant(), real, orphan1, orphan2]);
    expect(cleaned).toBeDefined();
    expect(cleaned).toHaveLength(2);
    expect(cleaned![1]).toBe(real);
  });

  it("碎片插在空 message/text 块之间仍归属最近真调用（kimi 空 item 穿插形态）", () => {
    const msg = {
      ...fragmentedAssistant(),
      content: [
        { type: "toolCall", id: "bash_0_x|fc_real", name: "bash", arguments: {}, argumentsError: "e\n\nReceived arguments:\n{" },
        { type: "text", text: "" },
        { type: "toolCall", id: "|fc_a", name: "", arguments: {}, argumentsError: "e\n\nReceived arguments:\n\"cmd\": \"" },
        { type: "text", text: "" },
        { type: "toolCall", id: "|fc_b", name: "", arguments: {}, argumentsError: "e\n\nReceived arguments:\nls\"}" },
      ],
    } as unknown as AssistantMessage;
    const cleaned = aggregateFragmentedToolCalls([msg]);
    const call = (cleaned![0] as AssistantMessage).content.find((b) => b.type === "toolCall") as { arguments: Record<string, unknown> };
    expect(call.arguments).toEqual({ cmd: "ls" });
  });

  it("无碎片无孤儿返回 undefined（零拷贝）", () => {
    const healthy = poisonedAssistant("正常");
    const result = toolResult("search_memory_0_x|fc_a", "search_memory");
    expect(aggregateFragmentedToolCalls([healthy, result])).toBeUndefined();
  });

  it("非 openai-responses 的碎片形态不动（收敛域）", () => {
    const other = {
      ...fragmentedAssistant(),
      api: "anthropic-messages",
    } as unknown as AssistantMessage;
    expect(aggregateFragmentedToolCalls([other])).toBeUndefined();
  });

  it("碎片在无前置真调用时直接丢弃，不炸", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "|fc_lonely", name: "", arguments: {}, argumentsError: "e\n\nReceived arguments:\n{\"x\":" },
      ],
      api: "openai-responses", provider: "kimi", model: "k3.1-pro",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 0,
    } as unknown as AssistantMessage;
    const cleaned = aggregateFragmentedToolCalls([msg]);
    expect((cleaned![0] as AssistantMessage).content).toHaveLength(0);
  });

  it("拼接后仍非法 JSON：真 block 保持原状，碎片仍被剔除（保守退化路径）", () => {
    const msg = {
      ...fragmentedAssistant(),
      content: [
        { type: "toolCall", id: "bash_0_x|fc_real", name: "bash", arguments: { keep: true } },
        { type: "toolCall", id: "|fc_a", name: "", arguments: {}, argumentsError: "e\n\nReceived arguments:\ngarbage{" },
      ],
    } as unknown as AssistantMessage;
    const cleaned = aggregateFragmentedToolCalls([msg]);
    const calls = (cleaned![0] as AssistantMessage).content.filter((b) => b.type === "toolCall") as Array<{ arguments: Record<string, unknown>; argumentsError?: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual({ keep: true });
    expect(calls[0].argumentsError).toBeUndefined();
  });

  it("混合序列：未受影响消息保持引用，孤儿剔除不留洞", () => {
    const user = { role: "user", content: "hi" } as Message;
    const healthy = poisonedAssistant("正常");
    const poisoned = fragmentedAssistant();
    const realResult = toolResult("bash_0_e8eeecff|fc_34te", "bash");
    const orphan = toolResult("|fc_EYFZfTWTwDul0Yuw8Zj0ZuJq", "");
    const cleaned = aggregateFragmentedToolCalls([user, healthy, poisoned, realResult, orphan]);
    expect(cleaned).toHaveLength(4);
    expect(cleaned![0]).toBe(user);
    expect(cleaned![1]).toBe(healthy);
    expect(cleaned![3]).toBe(realResult);
  });
});

  it("name-only 畸形（call_id 非空 name 空）：toolCall 与其 output 对称剔除，fc/output 配对不破坏", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "bash_0|fc_real", name: "bash", arguments: {}, argumentsError: "e\n\nReceived arguments:\n{}" },
        { type: "toolCall", id: "bash_1|fc_nameless", name: "", arguments: {}, argumentsError: "e\n\nReceived arguments:\n{}" },
      ],
      api: "openai-responses", provider: "kimi", model: "k3.1-pro",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 0,
    } as unknown as AssistantMessage;
    const realResult = toolResult("bash_0|fc_real", "bash");
    const namelessResult = toolResult("bash_1|fc_nameless", "");
    const cleaned = aggregateFragmentedToolCalls([msg, realResult, namelessResult]);
    const calls = (cleaned![0] as AssistantMessage).content.filter((b) => b.type === "toolCall");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: "bash_0|fc_real", name: "bash" });
    expect(cleaned).toHaveLength(2);
    expect(cleaned![1]).toBe(realResult);
  });

  it("name-only 畸形的参数不并入真调用（防错归属）", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "bash_0|fc_real", name: "bash", arguments: {}, argumentsError: "e\n\nReceived arguments:\n{}" },
        { type: "toolCall", id: "bash_1|fc_nameless", name: "", arguments: {}, argumentsError: "e\n\nReceived arguments:\n{\"evil\": 1}" },
      ],
      api: "openai-responses", provider: "kimi", model: "k3.1-pro",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 0,
    } as unknown as AssistantMessage;
    const cleaned = aggregateFragmentedToolCalls([msg]);
    const call = (cleaned![0] as AssistantMessage).content.find((b) => b.type === "toolCall") as { arguments: Record<string, unknown> };
    expect(call.arguments).toEqual({});
  });

  it("toolName 空的 toolResult（无论 isError）作为孤儿剔除，真结果保留", () => {
    const okOrphan = { ...toolResult("|fc_x", ""), isError: false } as Message;
    const errOrphan = toolResult("|fc_y", "");
    const real = toolResult("bash_0|fc_real", "bash");
    const cleaned = aggregateFragmentedToolCalls([okOrphan, errOrphan, real]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned![0]).toBe(real);
  });
