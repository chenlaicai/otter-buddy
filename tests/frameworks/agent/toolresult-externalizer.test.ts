import { describe, it, expect } from "vitest";
import {
  externalizeHistoricalToolResults,
  PROJECT_MIN_CHARS,
  KEEP_HEAD_CHARS,
} from "@frameworks/agent/toolresult-externalizer";

/** 构造 user 消息 */
function user(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() };
}

/** 构造 toolResult 消息 */
function toolResult(content: Array<{ type: string; [k: string]: unknown }>, toolCallId = "tc-1", toolName = "bash", isError = false) {
  return { role: "toolResult" as const, toolCallId, toolName, content, isError, timestamp: Date.now() };
}

/** 构造 text 块 */
function textBlock(t: string) {
  return { type: "text" as const, text: t };
}

/** 构造 image 块 */
function imageBlock() {
  return { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" };
}

/** 构造超门槛大文本（长度可控，内容含可断言的头部/尾部标记） */
function bigText(totalChars = 5_000) {
  const head = "HEAD-MARKER 开头内容;";
  const tail = ";TAIL-MARKER 结尾内容";
  return head + "x".repeat(Math.max(0, totalChars - head.length - tail.length)) + tail;
}

/** 期望的收缩产物（与实现同模板；模板稳定性由「幂等」用例交叉验证） */
function projectedOf(original: string) {
  return `${original.slice(0, KEEP_HEAD_CHARS)}…\n\n[工具返回值已投影：原 ${original.length} 字符。历史层收缩仅保留开头；完整原文在 session 历史 jsonl，可按本条 toolCallId 检索回读，或重新执行原工具获取]`;
}

describe("externalizeHistoricalToolResults", () => {
  it("历史大 toolResult 文本块收缩为头 + 收缩标记（含原字符数与回读提示）", () => {
    const big = bigText(5_000);
    const messages = [
      user("跑个命令"),
      toolResult([textBlock(big)], "tc-1"),
      user("继续"),
      toolResult([textBlock(bigText(2_000))], "tc-2"),
    ];

    const result = externalizeHistoricalToolResults(messages);

    const projected = result[1];
    expect(projected.content[0].text).toBe(projectedOf(big));
    expect(projected.content[0].text).toContain("HEAD-MARKER 开头内容");
    expect(projected.content[0].text).not.toContain("TAIL-MARKER");
    expect(projected.content[0].text).toContain("原 5000 字符");
    expect(projected.content[0].text).toContain("toolCallId");
    // 消息其余元数据不动
    expect(projected.toolCallId).toBe("tc-1");
    expect(projected.isError).toBe(false);
  });

  it("当轮（最后一个 user 之后）的大 toolResult 原样保留", () => {
    const big = bigText(5_000);
    const messages = [
      user("上一轮"),
      toolResult([textBlock(big)], "tc-old"),
      user("这一轮"),
      toolResult([textBlock(big)], "tc-current"),
    ];

    const result = externalizeHistoricalToolResults(messages);

    expect(result[3]).toBe(messages[3]); // 当轮引用不动
    expect(result[3].content[0].text).toBe(big);
  });

  it("invoke 内多步工具链（assistant/toolResult 交错）在当前 turn 内全保留", () => {
    const big = bigText(3_000);
    const messages = [
      user("旧任务"),
      toolResult([textBlock(big)], "tc-old"),
      user("新任务"),
      toolResult([textBlock(big)], "tc-s1"),
      { role: "assistant" as const, content: [{ type: "toolCall" as const, id: "tc-s2", name: "bash", arguments: {} }] },
      toolResult([textBlock(big)], "tc-s2"),
    ];

    const result = externalizeHistoricalToolResults(messages);

    expect(result[3]).toBe(messages[3]);
    expect(result[5]).toBe(messages[5]);
    expect(result[1]).not.toBe(messages[1]); // 仅历史区收缩
  });

  it("历史小 toolResult（≤门槛）不动", () => {
    const small = "s".repeat(PROJECT_MIN_CHARS); // 恰 = 门槛，不投影
    const messages = [
      user("hi"),
      toolResult([textBlock(small)], "tc-1"),
      user("hi again"),
      toolResult([textBlock("ok")], "tc-2"),
    ];

    const result = externalizeHistoricalToolResults(messages);

    expect(result).toBe(messages); // zero-copy：无任何变化返回原数组
  });

  it("幂等：投影产物再投影一次不变（缩到门槛下，天然跳过）", () => {
    const big = bigText(8_000);
    const messages = [
      user("task"),
      toolResult([textBlock(big)], "tc-1"),
      user("next"),
      toolResult([textBlock("ok")], "tc-2"),
    ];

    const once = externalizeHistoricalToolResults(messages);
    const twice = externalizeHistoricalToolResults(once);

    expect(twice[1].content[0].text).toBe(once[1].content[0].text);
    expect(once[1].content[0].text.length).toBeLessThan(PROJECT_MIN_CHARS);
  });

  it("混合 content（text + image）只收缩超大 text 块，其余块原样", () => {
    const big = bigText(4_000);
    const messages = [
      user("读文件"),
      toolResult([textBlock(big), imageBlock(), textBlock("小文本")], "tc-1"),
      user("下一轮"),
      toolResult([textBlock("ok")], "tc-2"),
    ];

    const result = externalizeHistoricalToolResults(messages);

    const content = result[1].content;
    expect(content[0].text).toBe(projectedOf(big));
    expect(content[1]).toBe(messages[1].content[1]); // image 块原样（image-externalizer 管）
    expect(content[2]).toBe(messages[1].content[2]); // 小文本原样
  });

  it("无 turn 边界消息（全是 toolResult）时全部保守保留", () => {
    const messages = [toolResult([textBlock(bigText(3_000))], "tc-1"), toolResult([textBlock(bigText(3_000))], "tc-2")];

    const result = externalizeHistoricalToolResults(messages);

    expect(result).toBe(messages);
  });

  it("isError 结果同样收缩，但错误标志与元数据保留", () => {
    const bigErr = "[错误] " + "e".repeat(3_000);
    const messages = [
      user("try"),
      toolResult([textBlock(bigErr)], "tc-err", "bash", true),
      user("retry"),
      toolResult([textBlock("ok")], "tc-ok"),
    ];

    const result = externalizeHistoricalToolResults(messages);

    expect(result[1].content[0].text).toBe(projectedOf(bigErr));
    expect(result[1].isError).toBe(true);
    expect(result[1].toolCallId).toBe("tc-err");
  });

  it("多文本块各自独立判门槛收缩", () => {
    const bigA = bigText(2_000);
    const bigB = bigText(3_000);
    const messages = [
      user("go"),
      toolResult([textBlock(bigA), textBlock(bigB)], "tc-1"),
      user("next"),
      toolResult([textBlock("ok")], "tc-2"),
    ];

    const result = externalizeHistoricalToolResults(messages);

    expect(result[1].content[0].text).toBe(projectedOf(bigA));
    expect(result[1].content[1].text).toBe(projectedOf(bigB));
  });

  it("非 toolResult 消息（assistant 文本等）即使超大也不动", () => {
    const big = bigText(5_000);
    const messages = [
      user("hi"),
      { role: "assistant" as const, content: [textBlock(big)] },
      user("again"),
      toolResult([textBlock("ok")], "tc-1"),
    ];

    const result = externalizeHistoricalToolResults(messages);

    expect(result).toBe(messages); // zero-copy
  });

  it("真实 session 消息结构（含 usage/stopReason 等字段）不被破坏", () => {
    const big = bigText(4_000);
    const realistic = {
      role: "toolResult" as const,
      toolCallId: "tc-real",
      toolName: "read",
      content: [textBlock(big)],
      isError: false,
      timestamp: 1758520000000,
    };
    const messages = [user("read it"), realistic, user("next"), toolResult([textBlock("ok")], "tc-2")];

    const result = externalizeHistoricalToolResults(messages);

    expect(Object.keys(result[1]).sort()).toEqual(Object.keys(realistic).sort());
    expect(result[1].content[0].text).toBe(projectedOf(big));
    expect(result[1].timestamp).toBe(1758520000000);
  });
});
