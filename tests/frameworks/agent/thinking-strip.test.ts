import { describe, it, expect } from "vitest";
import { stripHistoricalThinking } from "@frameworks/agent/model-runtime-registry";

/** 构造 assistant 消息（匹配 SDK AssistantMessage 结构） */
function assistant(content: Array<{ type: string; [k: string]: unknown }>) {
  return { role: "assistant" as const, content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop" as const, api: "anthropic-messages" as const, provider: "mimo" as const, model: "mimo-v2.5-pro", timestamp: Date.now() };
}

/** 构造 user 消息（匹配 SDK UserMessage：content 为 string） */
function user(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() };
}

/** 构造 toolResult 消息（匹配 SDK ToolResultMessage） */
function toolResult(text: string, toolCallId = "tc-1", toolName = "bash") {
  return { role: "toolResult" as const, toolCallId, toolName, content: [{ type: "text" as const, text }], isError: false, timestamp: Date.now() };
}

/** 构造 thinking 块（匹配 SDK ThinkingContent） */
function thinking(text: string) {
  return { type: "thinking" as const, thinking: text };
}

/** 构造 text 块（匹配 SDK TextContent） */
function textBlock(t: string) {
  return { type: "text" as const, text: t };
}

/** 构造 toolCall 块（匹配 SDK ToolCall） */
function toolCall(name: string, id = `tc-${name}`) {
  return { type: "toolCall" as const, id, name, arguments: {} };
}

describe("stripHistoricalThinking", () => {
  it("保留最新 assistant 消息的 thinking，strip 历史的", () => {
    const messages = [
      user("问题1"),
      assistant([thinking("推理过程1"), textBlock("回答1")]),
      user("问题2"),
      assistant([thinking("推理过程2"), textBlock("回答2")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 第一条 assistant：thinking 被 strip
    expect(result[1].content).toEqual([textBlock("回答1")]);
    // 第二条 assistant（最新）：thinking 保留
    expect(result[3].content).toEqual([thinking("推理过程2"), textBlock("回答2")]);
  });

  it("不修改 user 和 toolResult 消息", () => {
    const messages = [
      user("问题"),
      assistant([thinking("思考"), textBlock("回答")]),
      toolResult("工具结果"),
    ];

    const result = stripHistoricalThinking(messages);

    expect(result[0]).toBe(messages[0]); // user 原引用
    expect(result[2]).toBe(messages[2]); // toolResult 原引用
  });

  it("没有 thinking 的 assistant 消息保持不变", () => {
    const messages = [
      user("问题1"),
      assistant([textBlock("纯文本回答")]),
      user("问题2"),
      assistant([thinking("新思考"), textBlock("新回答")]),
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
      assistant([thinking("新的思考"), textBlock("新回答")]),
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
      toolResult("命令输出", "tc-bash", "bash"),
      assistant([thinking("第2步思考"), toolCall("read")]),
      toolResult("文件内容", "tc-read", "read"),
      assistant([thinking("第3步思考"), textBlock("最终回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 第1步 assistant：thinking 被 strip
    expect(result[1].content).toEqual([toolCall("bash")]);
    // 第2步 assistant：thinking 被 strip
    expect(result[3].content).toEqual([toolCall("read")]);
    // 第3步 assistant（最新）：thinking 保留
    expect(result[5].content).toEqual([thinking("第3步思考"), textBlock("最终回答")]);
  });

  it("空消息列表返回空数组", () => {
    const result = stripHistoricalThinking([]);
    expect(result).toEqual([]);
  });

  it("只有一条 assistant 消息时保留 thinking", () => {
    const messages = [
      user("问题"),
      assistant([thinking("思考"), textBlock("回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 唯一的 assistant 消息就是最新的，保留
    expect(result[1].content).toEqual([thinking("思考"), textBlock("回答")]);
  });

  it("assistant 消息有多个 thinking 块时全部 strip", () => {
    const messages = [
      user("问题1"),
      assistant([thinking("思考A"), thinking("思考B"), textBlock("回答")]),
      user("问题2"),
      assistant([thinking("新思考"), textBlock("新回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // 第一条 assistant：两个 thinking 都被 strip
    expect(result[1].content).toEqual([textBlock("回答")]);
    // 第二条 assistant（最新）：thinking 保留
    expect(result[3].content).toEqual([thinking("新思考"), textBlock("新回答")]);
  });

  it("历史 assistant 消息只有 thinking + toolCall 时 strip thinking 保留 toolCall", () => {
    const messages = [
      user("问题1"),
      assistant([thinking("分析代码"), toolCall("bash"), toolCall("read")]),
      toolResult("bash 输出", "tc-bash", "bash"),
      toolResult("read 输出", "tc-read", "read"),
      user("问题2"),
      assistant([thinking("新分析"), textBlock("结论")]),
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
      assistant([thinking("思考"), textBlock("回答")]),
    ];

    const result = stripHistoricalThinking(messages);

    // compactionSummary 不是 assistant，保持不变
    expect(result[0]).toBe(compactionSummary);
  });

  it("真实 session 对照：4 轮 assistant + 2 轮 toolResult 交错", () => {
    // 模拟 session 2026-08-07T03-28-36-045Z 的 Line 3-14 结构
    const messages = [
      user("在《对话ui优化》中，我手动中断，但是大獭又立马说话！"),
      assistant([thinking("搭档在抱怨一个bug..."), toolCall("search_memory"), toolCall("search_memory")]),
      toolResult("记忆搜索结果1...", "tc-sm-1", "search_memory"),
      toolResult("记忆搜索结果2...", "tc-sm-2", "search_memory"),
      assistant([thinking("找到了相关文档..."), toolCall("search_memory"), toolCall("search_memory")]),
      toolResult("记忆搜索结果3...", "tc-sm-3", "search_memory"),
      toolResult("记忆搜索结果4...", "tc-sm-4", "search_memory"),
      assistant([thinking("继续分析..."), textBlock("详细分析文本..."), toolCall("search_memory"), toolCall("search_memory")]),
      toolResult("记忆搜索结果5...", "tc-sm-5", "search_memory"),
      toolResult("记忆搜索结果6...", "tc-sm-6", "search_memory"),
      user("重新分析和修复"),
      assistant([thinking("现在我看到了关键点：1. 后端 abort 端点... 2. 前端 SSE 处理..."), textBlock("我已经定位到问题...")]),
    ];

    const result = stripHistoricalThinking(messages);

    // Line 4 assistant：thinking 被 strip，toolCall 保留
    expect(result[1].content).toEqual([toolCall("search_memory"), toolCall("search_memory")]);
    // Line 7 assistant：thinking 被 strip
    expect(result[4].content).toEqual([toolCall("search_memory"), toolCall("search_memory")]);
    // Line 10 assistant：thinking 被 strip，textBlock + toolCall 保留
    expect(result[7].content).toEqual([textBlock("详细分析文本..."), toolCall("search_memory"), toolCall("search_memory")]);
    // Line 14 assistant（最新）：thinking 完整保留
    expect(result[11].content).toEqual([
      thinking("现在我看到了关键点：1. 后端 abort 端点... 2. 前端 SSE 处理..."),
      textBlock("我已经定位到问题..."),
    ]);
    // toolResult 消息全部不变
    expect(result[2]).toBe(messages[2]);
    expect(result[3]).toBe(messages[3]);
    expect(result[5]).toBe(messages[5]);
    expect(result[6]).toBe(messages[6]);
    expect(result[8]).toBe(messages[8]);
    expect(result[9]).toBe(messages[9]);
  });
});
