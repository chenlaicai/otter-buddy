import { describe, it, expect } from "vitest";
import { stripHistoricalThinking } from "@frameworks/agent/pi-session-factory";

/** 构造 assistant 消息 */
function assistant(content: Array<{ type: string; [k: string]: unknown }>) {
  return { role: "assistant" as const, content };
}

/** 构造 user 消息 */
function user(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }] };
}

/** 构造 toolResult 消息 */
function toolResult(text: string) {
  return { role: "toolResult" as const, content: [{ type: "text" as const, text }] };
}

/** 构造 thinking 块 */
function thinking(text: string) {
  return { type: "thinking" as const, thinking: text };
}

/** 构造 text 块 */
function text(t: string) {
  return { type: "text" as const, text: t };
}

/** 构造 toolCall 块 */
function toolCall(name: string) {
  return { type: "toolCall" as const, name, arguments: "{}", toolCallId: `tc-${name}` };
}

describe("stripHistoricalThinking", () => {
  it("保留最新 assistant 消息的 thinking，strip 历史的", () => {
    const messages = [
      user("问题1"),
      assistant([thinking("推理过程1"), text("回答1")]),
      user("问题2"),
      assistant([thinking("推理过程2"), text("回答2")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 第一条 assistant：thinking 被 strip
    expect(result[1].content).toEqual([text("回答1")]);
    // 第二条 assistant（最新）：thinking 保留
    expect(result[3].content).toEqual([thinking("推理过程2"), text("回答2")]);
  });

  it("不修改 user 和 toolResult 消息", () => {
    const messages = [
      user("问题"),
      assistant([thinking("思考"), text("回答")]),
      toolResult("工具结果"),
    ];

    const result = stripHistoricalThinking(messages);

    expect(result[0]).toBe(messages[0]); // user 原引用
    expect(result[2]).toBe(messages[2]); // toolResult 原引用
  });

  it("没有 thinking 的 assistant 消息保持不变", () => {
    const messages = [
      user("问题1"),
      assistant([text("纯文本回答")]),
      user("问题2"),
      assistant([thinking("新思考"), text("新回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 第一条 assistant 无 thinking，保持原引用
    expect(result[1]).toBe(messages[1]);
    // 第二条 assistant 有 thinking 但是最新的，保持原引用
    expect(result[3]).toBe(messages[3]);
  });

  it("abort 保护：只有 thinking 无 text 的 assistant 消息保留原样", () => {
    const messages = [
      user("问题1"),
      assistant([thinking("abort 前的思考")]), // 只有 thinking，无 text
      user("问题2"),
      assistant([thinking("新的思考"), text("新回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // abort 的 assistant 消息：只有 thinking，strip 后 content 为空 → 保留原样
    expect(result[1]).toBe(messages[1]);
    expect(result[1].content).toEqual([thinking("abort 前的思考")]);
  });

  it("多步工具调用：中间步骤的 thinking 被 strip，最新保留", () => {
    const messages = [
      user("执行任务"),
      assistant([thinking("第1步思考"), toolCall("bash")]),
      toolResult("命令输出"),
      assistant([thinking("第2步思考"), toolCall("read")]),
      toolResult("文件内容"),
      assistant([thinking("第3步思考"), text("最终回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 第1步 assistant：thinking 被 strip
    expect(result[1].content).toEqual([toolCall("bash")]);
    // 第2步 assistant：thinking 被 strip
    expect(result[3].content).toEqual([toolCall("read")]);
    // 第3步 assistant（最新）：thinking 保留
    expect(result[5].content).toEqual([thinking("第3步思考"), text("最终回答")]);
  });

  it("空消息列表返回空数组", () => {
    const result = stripHistoricalThinking([]);
    expect(result).toEqual([]);
  });

  it("只有一条 assistant 消息时保留 thinking", () => {
    const messages = [
      user("问题"),
      assistant([thinking("思考"), text("回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 唯一的 assistant 消息就是最新的，保留
    expect(result[1].content).toEqual([thinking("思考"), text("回答")]);
  });

  it("assistant 消息有多个 thinking 块时全部 strip", () => {
    const messages = [
      user("问题1"),
      assistant([thinking("思考A"), thinking("思考B"), text("回答")]),
      user("问题2"),
      assistant([thinking("新思考"), text("新回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 第一条 assistant：两个 thinking 都被 strip
    expect(result[1].content).toEqual([text("回答")]);
    // 第二条 assistant（最新）：thinking 保留
    expect(result[3].content).toEqual([thinking("新思考"), text("新回答")]);
  });

  it("历史 assistant 消息只有 thinking + toolCall 时 strip thinking 保留 toolCall", () => {
    const messages = [
      user("问题1"),
      assistant([thinking("分析代码"), toolCall("bash"), toolCall("read")]),
      toolResult("bash 输出"),
      toolResult("read 输出"),
      user("问题2"),
      assistant([thinking("新分析"), text("结论")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 第一条 assistant：thinking 被 strip，toolCall 保留
    expect(result[1].content).toEqual([toolCall("bash"), toolCall("read")]);
  });

  it("compaction summary 消息不受影响", () => {
    const compactionSummary = { role: "compactionSummary" as const, content: [{ type: "text" as const, text: "摘要" }] };
    const messages = [
      compactionSummary,
      user("新问题"),
      assistant([thinking("思考"), text("回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // compactionSummary 不是 assistant，保持不变
    expect(result[0]).toBe(compactionSummary);
  });
});
