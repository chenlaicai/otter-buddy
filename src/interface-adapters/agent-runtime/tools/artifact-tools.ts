import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";

/**
 * F20260807factlim: content 预览截断。按 code point（而非 UTF-16 code unit）切片，
 * 避免 slice() 切断 emoji 等代理对产生乱码。
 */
function truncateContentPreview(content: string | null, maxCodePoints = 200): string | null {
  if (!content) return content;
  const chars = Array.from(content);
  return chars.length > maxCodePoints ? chars.slice(0, maxCodePoints).join("") + "…(已截断)" : content;
}

export function createListArtifactsTool(ctx: ToolContext): AgentTool {
  return {
    name: "list_artifacts",
    description: "查询当前对话的产物清单（linked resources）. When: 看本场对话产出过哪些资源（PR/file/fact 等）/ 找之前登记的产物. Output: 产物列表，可按 status/resourceType/groupId 过滤. TIP: 不传 status 返回 active+superseded（排除 archived）.",
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
        content: truncateContentPreview(r.content),
        category: r.category, userFlagged: r.userFlagged,
        status: r.status, groupId: r.groupId, linkedAtTurnNumber: r.linkedAtTurnNumber,
        statusChangedAtTurnNumber: r.statusChangedAtTurnNumber, supersededBy: r.supersededBy,
      }))));
    },
  };
}

export function createUpdateArtifactStatusTool(ctx: ToolContext): AgentTool {
  return {
    name: "update_artifact_status",
    description: "更新产物生命周期状态（superseded/archived）. When: 新版本产出后旧版本 superseded / PR 合入或资源失效 archived. Not for: 删除资源 → 不存在删除，只用状态管理. Output: 更新确认. GOTCHA: superseded 必须提供 supersededBy 指向新版本. BOUNDARY: 不可逆——状态变更后不能回退.",
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
        return errorResponse("[错误] status 必须是 'superseded' 或 'archived'");
      }

      if (targetStatus === "superseded" && !supersededBy) {
        return errorResponse("[错误] status 为 'superseded' 时必须提供 supersededBy");
      }

      const turnNumber = await ctx.client.conversation.getActiveTurnNumber(ctx.conversationId);
      await ctx.client.resource.updateStatus(artifactId, targetStatus, turnNumber, supersededBy);
      return textResponse(`Artifact ${artifactId} status updated to ${targetStatus}`);
    },
  };
}
