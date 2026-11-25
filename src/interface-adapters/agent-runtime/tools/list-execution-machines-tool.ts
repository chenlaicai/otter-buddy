import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";

/**
 * list_execution_machines：执行机资源池感知工具（F20261125expot PR-1）。
 *
 * deferred 工具（tool_search 检索面，不占常驻上下文）——description 是 BM25 索引语料，
 * 覆盖「执行机/机器/machine/在线/设备」等检索词。数据源与 `/api/execution-machines`
 * 同源同投影（单一实现见 usecases/execution/execution-machine-pool.ts）。
 *
 * 只读查询，无副作用；replay 安全。
 */
export function createListExecutionMachinesTool(ctx: ToolContext): AgentTool {
  return {
    name: "list_execution_machines",
    description:
      "查询执行机资源池（只读）：返回 {machines: [{id, name, online, lastSeenAt, local?}], currentMachineId}——local 行带 local:true（中枢所在机器，恒 online）；connector 设备含在线状态与最近在线时间。用于感知多执行机环境（multi-machine / execution machines）中有哪些机器可用——不假设环境只有一台机器。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      if (!ctx.listExecutionMachines) {
        return errorResponse("[错误] 本会话未注入执行机池数据源（listExecutionMachines 依赖缺失）");
      }
      try {
        const snapshot = await ctx.listExecutionMachines();
        return textResponse(JSON.stringify(snapshot, null, 2));
      } catch (err) {
        return errorResponse(
          `[错误] 执行机池查询失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
