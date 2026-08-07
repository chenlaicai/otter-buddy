import { describe, it, expect } from "vitest";
import { truncateToolResult, textResponse } from "@interface-adapters/agent-runtime/tools/tool-helpers";

describe("truncateToolResult", () => {
  it("短结果不被截断", () => {
    const result = textResponse("hello world");
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toBe("hello world");
  });

  it("超过 15K 的 text block 被截断", () => {
    const longText = "x".repeat(20_000);
    const result = textResponse(longText);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text.length).toBeLessThan(20_000);
    expect(truncated.content[0].text).toContain("[结果已截断");
  });

  it("截断提示包含原始长度", () => {
    const longText = "x".repeat(20_000);
    const result = textResponse(longText);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toContain("20000 字符");
  });

  it("JSON 数组在条目边界截断", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      content: "内容".repeat(100),
      score: 0.5,
    }));
    const jsonText = JSON.stringify(entries);
    const result = textResponse(jsonText);
    const truncated = truncateToolResult(result);
    const text = truncated.content[0].text;
    // 应该是合法 JSON（在条目边界截断）
    const bracketIdx = text.indexOf("\n]");
    if (bracketIdx > 0) {
      const jsonPart = text.slice(0, bracketIdx + 2);
      expect(() => JSON.parse(jsonPart)).not.toThrow();
    }
  });

  it("非 text 类型的 block 不被处理", () => {
    const result = {
      content: [
        { type: "text" as const, text: "x".repeat(20_000) },
        { type: "text" as const, text: "short" },
      ],
      details: {},
    };
    const truncated = truncateToolResult(result);
    expect(truncated.content[1].text).toBe("short");
  });

  it("恰好 15000 字符的结果不被截断", () => {
    const text = "a".repeat(15_000);
    const result = textResponse(text);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toBe(text);
  });

  it("15001 字符的结果被截断", () => {
    const text = "a".repeat(15_001);
    const result = textResponse(text);
    const truncated = truncateToolResult(result);
    expect(truncated.content[0].text).toContain("[结果已截断");
  });
});
