import { describe, expect, it } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

function contextWithTurnText(text: string): ToolContext {
  return {
    client: {} as OtterToolClient,
    otterId: "big",
    conversationId: "conv",
    currentMessageId: "message",
    currentInvokeId: "invoke",
    getTurnAssistantText: () => text,
  };
}

describe("#1837 yield 对直出文本的纠错", () => {
  it("有普通 assistant 文本但未 speak 时，明确告知草稿不可见并要求用 speak 重发", async () => {
    const ctx = contextWithTurnText("这段内容只是模型草稿");
    const tool = createTools(ctx).find(t => t.name === "yield")!;
    const result = await tool.execute("yield-1", { to: ["user"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("普通文本");
    expect(result.content[0].text).toContain("只有你自己能看到");
    expect(result.content[0].text).toContain("speak(body)");
  });

  it("没有任何文本或 speak 时，告知本轮未落账并指引补 speak（#1871 跨重启误判）", async () => {
    const ctx = contextWithTurnText("");
    const tool = createTools(ctx).find(t => t.name === "yield")!;
    const result = await tool.execute("yield-1", { to: ["user"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("本轮 invoke 尚未落账 speak");
    // #1871：明确指出计数跨 invoke（含重启/重试）归零，引导模型补 speak 而非排查工具
    expect(result.content[0].text).toContain("归零");
    expect(result.content[0].text).toContain("再调用一次 speak");
    expect(result.content[0].text).toContain("不要排查工具");
  });
});
