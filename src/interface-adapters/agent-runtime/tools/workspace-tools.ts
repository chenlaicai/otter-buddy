import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { AgentTool, ToolContext } from "./tool-factory";
import { textResponse } from "./tool-helpers";

function createWorkspaceInfoTool(ctx: ToolContext, workspaceGateway: WorkspaceGateway): AgentTool {
  return {
    name: "workspace_info",
    description: "获取当前对话的工作区信息。返回工作区绝对路径和根目录的文件/目录列表。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const ok = await workspaceGateway.exists(ctx.conversationId);
      if (!ok) return textResponse("[错误] 工作区不存在。");
      const entries = await workspaceGateway.listDir(ctx.conversationId);
      const wsPath = workspaceGateway.getWorkspacePath(ctx.conversationId);
      return textResponse(JSON.stringify({ path: wsPath, entries }));
    },
  };
}

function createWorkspaceListTool(ctx: ToolContext, workspaceGateway: WorkspaceGateway): AgentTool {
  return {
    name: "workspace_list",
    description: "列出工作区中的文件和目录。path 为可选的相对路径，不传则列出根目录。",
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
    description: "读取工作区中的文件内容。path 为相对于工作区根目录的路径。",
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
    description: "向工作区写入文件。自动创建中间目录。大小獭均可使用（工作区是沙箱，不影响项目代码）。",
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
