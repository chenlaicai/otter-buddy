import type { ActionRunner } from "@usecases/ports/execution-machine";
import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";
import { gateExecutionMachine, type ExecutionMachineGateResult } from "@usecases/execution/execution-machine-gate";

/**
 * 工作区工具的执行机落点接缝（动作级选择）：
 *
 * 五个工具的 machine 参数均必选（运行时 gate 校验——schema 不设 required，
 * 缺参报错走工具返回路径才能携带可用机器清单，模型读错误自纠错重带参数）。
 * 通过后经 ActionRunner.run(action, machineId) 的显式目标位路由
 * （统一注册制 Registry：无默认机、无对话绑定回退）。
 *
 * 落点标记口径：write/delete/info 在返回文本头部或 JSON 字段携带
 * `machine: <id>`；read 不加头部行（文件内容原样返回——头部行会破坏
 * JSON/代码文件的直接解析，读内容的落点核对走机器清单与动作台账）。
 */

/** machine 参数 schema（五工具共用；JSON Schema 形态，与 LegacyTool parameters 同构）。 */
const MACHINE_PROPERTY = {
  type: "string",
  description:
    "必选：本操作落点执行机 id（工作区跟机器走——选哪台机器，工作区就在那台机器的设备侧路径）。" +
    "机器池可用 list_execution_machines 实时查询；缺参/机器不存在/离线会报错并附可用机器清单（fail-closed，不自动换机）。",
} as const;

/** 先校验落点再执行动作：gate 失败即返回（不执行、不静默换机）。 */
async function gateMachine(params: Record<string, unknown>, ctx: ToolContext): Promise<ExecutionMachineGateResult> {
  return gateExecutionMachine(params.machine, ctx.listExecutionMachines);
}

function machineScopeLine(machineId: string): string {
  return `machine: ${machineId}\n`;
}

function createWorkspaceInfoTool(ctx: ToolContext, actionRunner: ActionRunner): AgentTool {
  return {
    name: "workspace_info",
    description: "获取当前对话的工作区信息（绝对路径 + 根目录列表）. When: 需要知道工作区在哪 / 浏览根目录结构. Output: { machine, path, entries }. BOUNDARY: 工作区是 sandbox，不影响项目代码.",
    parameters: { type: "object", properties: { machine: MACHINE_PROPERTY } },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const gate = await gateMachine(params, ctx);
      if (!gate.ok) return errorResponse(gate.message);
      const ok = await actionRunner.run({ type: "workspace.exists", input: { conversationId: ctx.conversationId } }, gate.machineId);
      if (!ok) return errorResponse("[错误] 工作区不存在。");
      const entries = await actionRunner.run({ type: "workspace.list", input: { conversationId: ctx.conversationId } }, gate.machineId);
      const wsPath = await actionRunner.run({ type: "workspace.path", input: { conversationId: ctx.conversationId } }, gate.machineId);
      return textResponse(JSON.stringify({ machine: gate.machineId, path: wsPath, entries }));
    },
  };
}

function createWorkspaceListTool(ctx: ToolContext, actionRunner: ActionRunner): AgentTool {
  return {
    name: "workspace_list",
    description: "列出工作区中指定目录的内容. When: 浏览工作区某目录结构. Output: machine 落点行 + 文件/目录 entries 列表. BOUNDARY: 只读; 工作区是 sandbox.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对于工作区根目录的路径（可选）" },
        machine: MACHINE_PROPERTY,
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const gate = await gateMachine(params, ctx);
      if (!gate.ok) return errorResponse(gate.message);
      const entries = await actionRunner.run({
        type: "workspace.list",
        input: { conversationId: ctx.conversationId, relativePath: params.path as string | undefined },
      }, gate.machineId);
      return textResponse(machineScopeLine(gate.machineId) + JSON.stringify(entries));
    },
  };
}

function createWorkspaceReadTool(ctx: ToolContext, actionRunner: ActionRunner): AgentTool {
  return {
    name: "workspace_read",
    description: "读取工作区中指定文件的内容. When: 需要查看工作区里某个文件. Output: 文件文本内容（原样，不加落点前缀——内容需可直接解析）. BOUNDARY: 只读.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对于工作区根目录）" },
        machine: MACHINE_PROPERTY,
      },
      required: ["path"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const gate = await gateMachine(params, ctx);
      if (!gate.ok) return errorResponse(gate.message);
      const content = await actionRunner.run({
        type: "workspace.read",
        input: { conversationId: ctx.conversationId, relativePath: params.path as string },
      }, gate.machineId);
      return textResponse(content);
    },
  };
}

function createWorkspaceWriteTool(ctx: ToolContext, actionRunner: ActionRunner): AgentTool {
  return {
    name: "workspace_write",
    description: "向工作区写入文件（自动创建中间目录）. When: 在工作区 sandbox 里产出/修改文件（如草稿、测试数据）. Not for: 修改项目代码 → 走 worktree-isolation skill. Output: machine 落点行 + 写入确认. BOUNDARY: 工作区是 sandbox. GOTCHA: 大小獭均可使用但只在自己的 sandbox 内有效.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对于工作区根目录）" },
        content: { type: "string", description: "文件内容" },
        machine: MACHINE_PROPERTY,
      },
      required: ["path", "content"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const gate = await gateMachine(params, ctx);
      if (!gate.ok) return errorResponse(gate.message);
      await actionRunner.run({
        type: "workspace.write",
        input: { conversationId: ctx.conversationId, relativePath: params.path as string, content: params.content as string },
      }, gate.machineId);
      return textResponse(`${machineScopeLine(gate.machineId)}文件已写入: ${params.path}`);
    },
  };
}

function createWorkspaceDeleteTool(ctx: ToolContext, actionRunner: ActionRunner): AgentTool {
  return {
    name: "workspace_delete",
    description: "删除工作区中的文件或目录. When: 回收工作区沙箱内的临时件/草稿（合入善后清整、时效性清理）. Not for: 删项目代码文件 → 在 worktree 内走 git；整个工作区回收 → 对话归档时系统整体删除. Output: machine 落点行 + 删除确认（含类型）. BOUNDARY: 只作用本对话工作区，路径穿越/symlink 逃逸/工作区根删除均拒绝. GOTCHA: 不可逆无回收站——目录须 recursive=true 才整树删除；删前建议先 workspace_list 确认目标.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件或目录路径（相对于工作区根目录）" },
        recursive: { type: "boolean", description: "删除目录时是否递归删除整树（默认 false；非空目录不传会拒绝；文件忽略此参数）" },
        machine: MACHINE_PROPERTY,
      },
      required: ["path"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const gate = await gateMachine(params, ctx);
      if (!gate.ok) return errorResponse(gate.message);
      const relPath = typeof params.path === "string" ? params.path : "";
      if (!relPath.trim()) {
        return errorResponse("[错误] path 不能为空。工作区根目录不许删除（整区回收随对话归档）。");
      }
      const recursive = params.recursive === true;
      try {
        const result = await actionRunner.run({
          type: "workspace.delete",
          input: { conversationId: ctx.conversationId, relativePath: relPath, recursive },
        }, gate.machineId);
        return textResponse(`${machineScopeLine(gate.machineId)}已删除${result.deleted === "directory" ? "目录" : "文件"}: ${relPath}`);
      } catch (err) {
        return errorResponse(`[错误] 删除失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export function createWorkspaceTools(ctx: ToolContext, actionRunner: ActionRunner): AgentTool[] {
  return [
    createWorkspaceInfoTool(ctx, actionRunner),
    createWorkspaceListTool(ctx, actionRunner),
    createWorkspaceReadTool(ctx, actionRunner),
    createWorkspaceWriteTool(ctx, actionRunner),
    createWorkspaceDeleteTool(ctx, actionRunner),
  ];
}
