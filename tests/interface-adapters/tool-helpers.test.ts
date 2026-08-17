import { describe, it, expect } from "vitest";
import { truncateToolResult, textResponse, MAX_TOOL_RESULT_CHARS } from "@usecases/ports/agent-tools";

describe("truncateToolResult", () => {
  it("短结果不被截断", () => {
    const result = textResponse("hello world");
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toBe("hello world");
  });

  it("恰好 MAX_TOOL_RESULT_CHARS 字符的结果不被截断", () => {
    const text = "a".repeat(MAX_TOOL_RESULT_CHARS);
    const result = textResponse(text);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toBe(text);
  });

  it("超过阈值的 text block 被截断并附加提示", () => {
    const longText = "x".repeat(20_000);
    const result = textResponse(longText);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toContain("[结果已截断");
    expect(truncated.content[0].text).toContain("请缩小查询范围");
  });

  // 质疑 1 修复：JSON 截断必须走到条目边界分支，不能假通过
  it("JSON 数组在条目边界截断，结果是合法 JSON", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      content: "x".repeat(1000),
      score: 0.5,
    }));
    const jsonText = JSON.stringify(entries);
    const result = textResponse(jsonText);
    const truncated = truncateToolResult(result);
    const text = truncated.content[0].text;

    // 截断提示存在（不泄露长度信息）
    expect(text).toContain("[结果已截断");
    expect(text).not.toMatch(/\d+ 字符/);

    // \n] 之前的部分必须是合法 JSON（条目边界截断）
    const bracketIdx = text.indexOf("\n]");
    expect(bracketIdx).toBeGreaterThan(0);
    const jsonPart = text.slice(0, bracketIdx + 2);
    const parsed = JSON.parse(jsonPart);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(20); // 确实截断了
    // 每个保留的条目结构完整
    expect(parsed[0]).toHaveProperty("id");
    expect(parsed[0]).toHaveProperty("content");
  });

  // 质疑 2 修复：非 JSON 文本截断路径
  it("非 JSON 长文本走纯字符截断，不产生 JSON 闭合", () => {
    const longText = "A".repeat(20_000);
    const result = textResponse(longText);
    const truncated = truncateToolResult(result);
    const text = truncated.content[0].text;

    // 被截断了
    expect(text).toContain("[结果已截断");
    // 不应以 \n] 结尾（不是 JSON 分支）
    expect(text).not.toMatch(/\n\]$/);
    // 截断后的主体部分长度 <= 阈值
    const tipIdx = text.indexOf("\n\n[结果已截断");
    expect(tipIdx).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  // 质疑 4 修复：多 block 时各 block 独立截断
  it("多 block 时各 block 独立截断，block 数量不变", () => {
    const result = {
      content: [
        { type: "text" as const, text: "x".repeat(20_000) },
        { type: "text" as const, text: "short" },
      ],
      details: {},
    };
    const truncated = truncateToolResult(result);
    expect(truncated.content.length).toBe(2);
    expect(truncated.content[0].text).toContain("[结果已截断");
    expect(truncated.content[1].text).toBe("short");
  });

  // 质疑 9 修复：details/terminate 透传
  it("details 和 terminate 字段透传不丢失", () => {
    const result = {
      content: [{ type: "text" as const, text: "hello" }],
      details: { foo: "bar", nested: { a: 1 } },
      terminate: true,
    };
    const truncated = truncateToolResult(result);
    expect(truncated.details).toEqual({ foo: "bar", nested: { a: 1 } });
    expect(truncated.terminate).toBe(true);
  });

  // 质疑 3 补充：大条目 JSON 退化路径
  it("JSON 数组单条目超阈值时退化到纯截断不崩溃", () => {
    const entries = [{ id: "e1", content: "x".repeat(16_000) }];
    const jsonText = JSON.stringify(entries);
    const result = textResponse(jsonText);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toContain("[结果已截断");
  });

  // 观察 1 补充：嵌套 JSON 结构支持
  it("嵌套 JSON 结构（wrapper + array）在条目边界截断", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      content: "x".repeat(1000),
    }));
    const jsonText = JSON.stringify({ data: entries, total: 20 });
    const result = textResponse(jsonText);
    const truncated = truncateToolResult(result);
    const text = truncated.content[0].text;

    expect(text).toContain("[结果已截断");
    // 应在数组内条目边界截断
    const arrStart = text.indexOf("[");
    expect(arrStart).toBeGreaterThanOrEqual(0);
    const bracketIdx = text.indexOf("\n]");
    expect(bracketIdx).toBeGreaterThan(arrStart);
  });

  // 观察 3 补充：空 JSON 数组
  it("空 JSON 数组不被截断", () => {
    const result = textResponse("[]");
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toBe("[]");
  });
});
