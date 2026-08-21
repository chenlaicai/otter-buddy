/**
 * F20260821evaf 二/三轮审视：search_memory 工具输出 shape 单测。
 * vecCoverage 透传是 agent 感知 FTS-only 降级/暗化条目的唯一通道（otter_context 告警已移除），
 * 此前在 clients/tool-factory 两层被丢弃——钉住最后一环的序列化契约。
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

function makeCtx(searchImpl: NonNullable<OtterToolClient["memory"]["search"]>): ToolContext {
  const client = {
    memory: { search: searchImpl },
  } as unknown as OtterToolClient;
  return { client, otterId: "otter-1", conversationId: "conv-1", currentMessageId: "msg-cur" };
}

function getSearchTool(ctx: ToolContext) {
  const tool = createTools(ctx).find(t => t.name === "search_memory");
  if (!tool) throw new Error("search_memory tool not registered");
  return tool;
}

describe("search_memory 工具输出 shape（F20260821evaf）", () => {
  it("vecCoverage + contextEntries 同时存在时全部序列化", async () => {
    const vecCoverage = { total: 10, withVec: 7, ratio: 0.7, vecDisabled: false };
    const entry = { id: "e1", content: "c", score: 0.5, layer: "project", createdAt: "2026-08-21T00:00:00Z" };
    const ctx = makeCtx(async () => ({ entries: [entry], contextEntries: [entry], vecCoverage }) as never);
    const result = await getSearchTool(ctx).execute("tc-1", { query: "q" });
    const parsed = JSON.parse((result as { content: Array<{ type: string; text: string }> }).content[0].text);
    expect(parsed.vecCoverage).toEqual(vecCoverage);
    expect(parsed.contextEntries).toHaveLength(1);
    expect(parsed.entries).toHaveLength(1);
  });

  it("无 contextEntries 时输出 entries + vecCoverage（不再退化为裸数组）", async () => {
    const vecCoverage = { total: 5, withVec: 0, ratio: 0, vecDisabled: true };
    const ctx = makeCtx(async () => ({ entries: [], vecCoverage }) as never);
    const result = await getSearchTool(ctx).execute("tc-1", { query: "q" });
    const parsed = JSON.parse((result as { content: Array<{ type: string; text: string }> }).content[0].text);
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.vecCoverage).toEqual(vecCoverage);
  });

  it("mock 无 vecCoverage 时不产生 undefined 字段", async () => {
    const ctx = makeCtx(async () => ({ entries: [] }) as never);
    const result = await getSearchTool(ctx).execute("tc-1", { query: "q" });
    const parsed = JSON.parse((result as { content: Array<{ type: string; text: string }> }).content[0].text);
    expect("vecCoverage" in parsed).toBe(false);
  });
});
