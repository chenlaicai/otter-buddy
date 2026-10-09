/**
 * F20261008gfrc（三步走③）：create_otter 元规则预告——回包含变体重试计数升级规则。
 *
 * 验证面：创建成功回包必须含「变体重试」预告文案 + blocked 升级指引（元规则预告
 * 是给大獭的派工提示，让「被拦勿变体重试」在 systemPrompt 阶段就带上）。
 * mock 策略复用 create-otter-ctx-budget.test.ts 的 makeCtx 模式。
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "@usecases/ports/agent-tools";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";

function makeCtx(): ToolContext {
  return {
    otterId: "otter-big",
    conversationId: "conv-1",
    currentMessageId: "msg-1",
    client: {
      otter: {
        create: vi.fn(async (p: { name: string }) => ({ id: `otter-${p.name}`, name: p.name })),
      },
      conversation: {
        participant: {
          getActive: vi.fn(async () => []),
          join: vi.fn(async () => ({})),
        },
      },
      dispatch: { createRecord: vi.fn(async () => {}) },
    },
  } as unknown as ToolContext;
}

function findCreateOtter(ctx: ToolContext) {
  const tool = createTools(ctx).find((t) => t.name === "create_otter");
  expect(tool, "create_otter 应注册").toBeDefined();
  return tool!;
}

describe("F20261008gfrc create_otter 元规则预告", () => {
  it("回包含变体重试计数升级预告与 blocked 指引", async () => {
    const tool = findCreateOtter(makeCtx());
    const result = await tool.execute("call-1", { name: "测试獭", systemPrompt: "干活" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // 预告要素①：变体重试会被计数升级（6h ≥3 次 → high）
    expect(text).toContain("变体重试");
    expect(text).toContain("升级");
    // 预告要素②：正道指引——报 blocked 而非绕试
    expect(text).toContain("blocked");
    // 原有就位待命提示不回归
    expect(text).toContain("已就位待命");
  });
});
