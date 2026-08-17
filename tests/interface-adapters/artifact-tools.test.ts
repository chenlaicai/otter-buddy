import { describe, it, expect } from "vitest";
import { createListArtifactsTool } from "@interface-adapters/agent-runtime/tools/artifact-tools";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

const TRUNCATED_MARK = "…(已截断)";

function makeListTool(content: string) {
  const resource = {
    id: "res-1", resourceType: "fact", url: null, title: "t", content,
    category: null, userFlagged: false, status: "active", groupId: null,
    linkedAtTurnNumber: 1, statusChangedAtTurnNumber: 1, supersededBy: null,
  };
  const client = {
    resource: {
      list: async () => [resource],
      listByGroup: async () => [resource],
    },
  } as unknown as OtterToolClient;

  const ctx: ToolContext = {
    client, otterId: "otter-1", conversationId: "conv-1", currentMessageId: "msg-1",
  };
  return createListArtifactsTool(ctx);
}

async function listContent(tool: { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }) {
  const res = await tool.execute("c1", {});
  return JSON.parse(res.content[0].text)[0].content as string;
}

describe("list_artifacts content 预览截断", () => {
  it("content 超过 200 个码位时截断并附加截断标记", async () => {
    const tool = makeListTool("x".repeat(250));

    const content = await listContent(tool);

    expect(content).toBe("x".repeat(200) + TRUNCATED_MARK);
  });

  it("content 不超过 200 个码位时原样返回", async () => {
    const original = "短内容";
    const tool = makeListTool(original);

    expect(await listContent(tool)).toBe(original);
  });

  it("含 emoji（代理对）时按码位截断，不切断代理对产生乱码", async () => {
    // 201 个码位（emoji 占 2 个 UTF-16 code unit）：截断到 200 个码位后必须是完整 emoji
    const tool = makeListTool("🦦".repeat(201));

    const content = await listContent(tool);

    expect(content).toBe("🦦".repeat(200) + TRUNCATED_MARK);
  });

  it("码位数恰好 200 但 code unit 超 200 时不误截断", async () => {
    // 199 个 ASCII + 1 个 emoji = 200 码位 / 201 code unit——旧实现按 code unit 判断会误截并切断代理对
    const original = "x".repeat(199) + "🦦";
    const tool = makeListTool(original);

    expect(await listContent(tool)).toBe(original);
  });
});
