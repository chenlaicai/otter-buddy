import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { AgentTool, ToolContext } from "./tool-factory";
import { textResponse, errorResponse } from "./tool-helpers";

function createWorkspaceInfoTool(ctx: ToolContext, workspaceGateway: WorkspaceGateway): AgentTool {
  return {
    name: "workspace_info",
    description: "获取当前对话的工作区信息（绝对路径 + 根目录列表）. When: 需要知道工作区在哪 / 浏览根目录结构. Output: { path, entries }. BOUNDARY: 工作区是 sandbox，不影响项目代码.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const ok = await workspaceGateway.exists(ctx.conversationId);
      if (!ok) return errorResponse("[错误] 工作区不存在。");
      const entries = await workspaceGateway.listDir(ctx.conversationId);
      const wsPath = workspaceGateway.getWorkspacePath(ctx.conversationId);
      return textResponse(JSON.stringify({ path: wsPath, entries }));
    },
  };
}

function createWorkspaceListTool(ctx: ToolContext, workspaceGateway: WorkspaceGateway): AgentTool {
  return {
    name: "workspace_list",
    description: "列出工作区中指定目录的内容. When: 浏览工作区某目录结构. Output: 文件/目录 entries 列表. BOUNDARY: 只读; 工作区是 sandbox.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对于工作区根目录的路径（可选）" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const entries = await workspaceGateway.listDir(ctx.conversationId, params.path as string | undefined);
      return textResponse(JSON.stringify(entries));
    },
  };
}

function createWorkspaceReadTool(ctx: ToolContext, workspaceGateway: WorkspaceGateway): AgentTool {
  return {
    name: "workspace_read",
    description: "读取工作区中指定文件的内容. When: 需要查看工作区里某个文件. Output: 文件文本内容. BOUNDARY: 只读; 工作区是 sandbox.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对于工作区根目录）" },
      },
      required: ["path"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const content = await workspaceGateway.readFile(ctx.conversationId, params.path as string);
      return textResponse(content);
    },
  };
}

function createWorkspaceWriteTool(ctx: ToolContext, workspaceGateway: WorkspaceGateway): AgentTool {
  return {
    name: "workspace_write",
    description: "向工作区写入文件（自动创建中间目录）. When: 在工作区 sandbox 里产出/修改文件（如草稿、测试数据）. Not for: 修改项目代码 → 走 worktree-isolation skill. Output: 写入确认. BOUNDARY: 工作区是 sandbox，不影响项目代码. GOTCHA: 大小獭均可使用但只在自己的 sandbox 内有效.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对于工作区根目录）" },
        content: { type: "string", description: "文件内容" },
      },
      required: ["path", "content"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      await workspaceGateway.writeFile(ctx.conversationId, params.path as string, params.content as string);
      return textResponse(`文件已写入: ${params.path}`);
    },
  };
}

export function createWorkspaceTools(ctx: ToolContext, workspaceGateway: WorkspaceGateway): AgentTool[] {
  return [
    createWorkspaceInfoTool(ctx, workspaceGateway),
    createWorkspaceListTool(ctx, workspaceGateway),
    createWorkspaceReadTool(ctx, workspaceGateway),
    createWorkspaceWriteTool(ctx, workspaceGateway),
  ];
}
