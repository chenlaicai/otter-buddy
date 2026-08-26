/**
 * F20260821evaf 二/三轮审视：search_memory 工具输出 shape 单测。
 * vecCoverage 透传是 agent 感知 FTS-only 降级/暗化条目的唯一通道（otter_context 告警已移除），
 * 此前在 clients/tool-factory 两层被丢弃——钉住最后一环的序列化契约。
 * F20260826rcmp 审视补充（mimo 必修）：钉住埋点接线——logSearch 被调用且参数正确
 * （含 beforeMessageId 传 ctx.currentMessageId、total 传检索真值两个审视修正）。
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

function makeCtx(searchImpl: NonNullable<OtterToolClient["memory"]["search"]>, logSearchImpl?: OtterToolClient["memory"]["logSearch"]): ToolContext {
  const client = {
    memory: { search: searchImpl, logSearch: logSearchImpl ?? (() => undefined) }, // F20260826rcmm Phase 0：埋点 mock（fire-and-forget）
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

describe("search_memory 埋点接线（F20260826rcmp 审视补充）", () => {
  it("logSearch 被调用且参数正确（beforeMessageId=当前消息、total=检索真值）", async () => {
    const entry = { id: "e1", content: "c", score: 0.5, layer: "project", createdAt: "2026-08-26T00:00:00Z" };
    const calls: Array<Record<string, unknown>> = [];
    const ctx = makeCtx(
      async () => ({ entries: [entry], total: 42 }) as never,
      (p) => { calls.push(p as unknown as Record<string, unknown>); },
    );
    await getSearchTool(ctx).execute("tc-1", { query: "检索埋点接线", limit: 5, detail_level: "summary" });

    expect(calls).toHaveLength(1);
    const logged = calls[0] as {
      query: string; conversationId: string; callerId: string;
      beforeMessageId?: string | null; detailLevel?: string;
      library?: string; limitCount?: number;
      topEntryIds: string[]; total: number;
    };
    expect(logged.query).toBe("检索埋点接线");
    expect(logged.conversationId).toBe("conv-1");
    expect(logged.callerId).toBe("otter-1");
    // kimi 发现 1：快照上界 = 触发检索的当前消息（排除自身，防自问自答污染标注）
    expect(logged.beforeMessageId).toBe("msg-cur");
    expect(logged.detailLevel).toBe("summary");
    expect(logged.limitCount).toBe(5);
    expect(logged.topEntryIds).toEqual(["e1"]);
    // kimi 发现 2：total 传检索系统真值（42），非 entries.length（1）
    expect(logged.total).toBe(42);
  });

  it("logSearch 抛错（同步 TypeError 场景）不影响工具返回", async () => {
    const entry = { id: "e1", content: "c", score: 0.5, layer: "project", createdAt: "2026-08-26T00:00:00Z" };
    const ctx = makeCtx(
      async () => ({ entries: [entry], total: 1 }) as never,
      () => { throw new TypeError("recordSearchQuery 未初始化"); },
    );
    const result = await getSearchTool(ctx).execute("tc-1", { query: "q" });
    const parsed = JSON.parse((result as { content: Array<{ type: string; text: string }> }).content[0].text);
    expect(parsed.entries).toHaveLength(1);
  });
});
