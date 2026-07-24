import type { AgentTool, ToolContext } from "./tool-factory";
import { textResponse } from "./tool-helpers";

export function createListArtifactsTool(ctx: ToolContext): AgentTool {
  return {
    name: "list_artifacts",
    description: "查询当前对话的产物清单。可按 status/resourceType/groupId 过滤。不传 status 时返回 active + superseded（排除 archived）。",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "superseded", "archived"], description: "按状态过滤（不传则排除 archived）" },
        resourceType: { type: "string", description: "按资源类型过滤（fact/pr/worktree/branch/file/url）" },
        groupId: { type: "string", description: "按特性分组 ID 过滤" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const status = params.status as string | undefined;
      const resourceType = params.resourceType as string | undefined;
      const groupId = params.groupId as string | undefined;

      let resources;
      if (groupId) {
        resources = await ctx.client.resource.listByGroup(ctx.conversationId, groupId);
      } else {
        resources = await ctx.client.resource.list(ctx.conversationId, {
          status: status as "active" | "superseded" | "archived" | undefined,
          resourceType,
        });
      }

      if (status) {
        resources = resources.filter(r => r.status === status);
      } else {
        resources = resources.filter(r => r.status !== "archived");
      }

      if (resourceType) {
        resources = resources.filter(r => r.resourceType === resourceType);
      }

      return textResponse(JSON.stringify(resources.map(r => ({
        id: r.id, resourceType: r.resourceType, url: r.url, title: r.title,
        content: r.content, category: r.category, userFlagged: r.userFlagged,
        status: r.status, groupId: r.groupId, linkedAtTurnNumber: r.linkedAtTurnNumber,
        statusChangedAtTurnNumber: r.statusChangedAtTurnNumber, supersededBy: r.supersededBy,
      }))));
    },
  };
}

export function createUpdateArtifactStatusTool(ctx: ToolContext): AgentTool {
  return {
    name: "update_artifact_status",
    description: "更新产物生命周期状态。生命周期规则：(1) 创建新版本资源后，将旧版本标记为 superseded 并提供 supersededBy；(2) PR 合入/资源失效后标记为 archived；(3) 不要删除资源，只用状态管理。",
    parameters: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "产物 ID（linked_resource ID）" },
        status: { type: "string", enum: ["superseded", "archived"], description: "目标状态" },
        supersededBy: { type: "string", description: "替代者的产物 ID（仅 superseded 时需要）" },
      },
      required: ["artifactId", "status"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const artifactId = params.artifactId as string;
      const targetStatus = params.status as string;
      const supersededBy = params.supersededBy as string | undefined;

      if (targetStatus !== "superseded" && targetStatus !== "archived") {
        return textResponse("Error: status must be 'superseded' or 'archived'");
      }

      if (targetStatus === "superseded" && !supersededBy) {
        return textResponse("Error: supersededBy is required when status is 'superseded'");
      }

      const turnNumber = await ctx.client.conversation.getActiveTurnNumber(ctx.conversationId);
      await ctx.client.resource.updateStatus(artifactId, targetStatus, turnNumber, supersededBy);
      return textResponse(`Artifact ${artifactId} status updated to ${targetStatus}`);
    },
  };
}
