/**
 * F20260912avlb delta 复审建议 1：query_dispatch_ledger 工具层测试。
 *
 * 覆盖：①不传 conversationId → queryRecords 收到 undefined（全表口径，与 web 端一致）
 *      ②传 conversationId → 限定单对话
 *      ③status/otterId 透传
 * 断言可观察行为（queryRecords 实参）而非内部调用细节——实参就是端口契约本身。
 */
import { describe, it, expect } from "vitest";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";

interface QueryCall {
  conversationId?: string;
  status?: string;
  otterId?: string;
}

function makeQueryDispatchLedgerTool() {
  const queryCalls: QueryCall[] = [];

  const client = {
    dispatch: {
      createRecord: async () => ({ id: "dispatch-1" }),
      markDispatched: async () => {},
      queryRecords: async (params: QueryCall) => {
        queryCalls.push(params);
        return [];
      },
    },
  } as unknown as OtterToolClient;

  const ctx: ToolContext = {
    client,
    otterId: "big-otter",
    conversationId: "conv-current",
    currentMessageId: "msg-1",
  };

  const tools = createTools(ctx);
  const tool = tools.find(t => t.name === "query_dispatch_ledger")!;
  return { tool, queryCalls };
}

describe("query_dispatch_ledger 工具（F20260912avlb：全对话查询能力）", () => {
  it("不传 conversationId → 全表口径（undefined 透传，不兜底当前对话）", async () => {
    const { tool, queryCalls } = makeQueryDispatchLedgerTool();
    await tool.execute("q1", {});

    expect(queryCalls).toHaveLength(1);
    // 关键断言：undefined（repo findByFilter 语义 = 全表），与 web 端 controller 口径一致
    expect(queryCalls[0]!.conversationId).toBeUndefined();
  });

  it("传 conversationId → 限定指定对话", async () => {
    const { tool, queryCalls } = makeQueryDispatchLedgerTool();
    await tool.execute("q2", { conversationId: "conv-target" });

    expect(queryCalls[0]!.conversationId).toBe("conv-target");
  });

  it("status / otterId 过滤参数透传", async () => {
    const { tool, queryCalls } = makeQueryDispatchLedgerTool();
    await tool.execute("q3", { status: "created", otterId: "otter-1" });

    expect(queryCalls[0]).toMatchObject({ status: "created", otterId: "otter-1" });
  });
});
