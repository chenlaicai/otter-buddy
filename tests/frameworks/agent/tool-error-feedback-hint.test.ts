/**
 * F20260904tflp：工具错误返回的 tool_use_feedback 触发提示。
 *
 * 方案背景：工具报错的精确摩擦时刻，在返回文本尾部追加一行引导提示，
 * 让海獭知道可用 healing 块报工具使用感受（type: tool_use_feedback，
 * description 以 [tool:工具名] 开头）。
 *
 * 断言点：
 * 1. isError 的工具结果尾部出现提示，且含正确的工具名
 * 2. 非 isError 的结果不追加（无噪音）
 * 3. speak 工具自身报错不追加（反馈动作发生在 speak 内，避免循环暗示）
 */
import { describe, it, expect } from "vitest";
import { buildCustomTools } from "@frameworks/agent/tool-builder";
import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { errorResponse, textResponse } from "@usecases/ports/agent-tools";

function makeTools(createToolsImpl: (ctx: ToolContext) => AgentTool[]) {
  return buildCustomTools({
    otterId: "test-otter",
    conversationId: "test-conv",
    allowedNames: ["search_memory", "speak"],
    otterToolClient: {} as never,
    createTools: (ctx: ToolContext) => createToolsImpl(ctx),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
  });
}

describe("F20260904tflp: 错误返回尾部 tool_use_feedback 提示", () => {
  it("isError 结果尾部追加提示，含正确工具名", async () => {
    const { tools } = makeTools(() => [
      {
        name: "search_memory",
        description: "test",
        parameters: { type: "object", properties: {} },
        execute: async () => errorResponse("[错误] 检索失败"),
      },
    ]);
    const result = await tools[0].execute("call-1", {});
    const text = result.content.find(c => c.type === "text")?.text ?? "";
    expect(text).toContain("[错误] 检索失败");
    expect(text).toContain("tool_use_feedback");
    expect(text).toContain("[tool:search_memory]");
  });

  it("非 isError 结果不追加提示（无噪音）", async () => {
    const { tools } = makeTools(() => [
      {
        name: "search_memory",
        description: "test",
        parameters: { type: "object", properties: {} },
        execute: async () => textResponse("正常结果"),
      },
    ]);
    const result = await tools[0].execute("call-1", {});
    const text = result.content.find(c => c.type === "text")?.text ?? "";
    expect(text).toBe("正常结果");
  });

  it("speak 自身报错不追加（避免循环暗示）", async () => {
    const { tools } = makeTools(() => [
      {
        name: "speak",
        description: "test",
        parameters: { type: "object", properties: {} },
        execute: async () => errorResponse("[错误] body 不能为空"),
      },
    ]);
    const result = await tools[0].execute("call-1", {});
    const text = result.content.find(c => c.type === "text")?.text ?? "";
    expect(text).not.toContain("tool_use_feedback");
  });

  it("isError 但 content 为空数组时不报错不追加（F20260904tflp 审视发现 3）", async () => {
    // 钉死空 content 的安全默认：[].map() => []，无 TypeError、无提示追加。
    // 防未来重构（map 改 forEach/push）时意外改变此行为。
    const { tools } = makeTools(() => [
      {
        name: "search_memory",
        description: "test",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [], details: {}, isError: true } as never),
      },
    ]);
    const result = await tools[0].execute("call-1", {});
    expect(result.content).toEqual([]);
  });
});
