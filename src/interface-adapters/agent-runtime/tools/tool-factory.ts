import type { SendMessage } from "@usecases/conversation/send-message";
import type { SearchMemory } from "@usecases/memory/search-memory";
import type { StoreMemory } from "@usecases/memory/store-memory";
import type { ManageMemory } from "@usecases/memory/manage-memory";
import type { CreateOtter } from "@usecases/otter/create-otter";
import type { DissolveOtter } from "@usecases/otter/dissolve-otter";
import type { ManageKeyInfo } from "@usecases/conversation/manage-key-info";
import type { ManageParticipant } from "@usecases/conversation/manage-participant";

/**
 * Agent 工具类型（与 frameworks 层 AgentTool 结构兼容）。
 * interface-adapters 层不依赖 frameworks，main.ts 负责注册到 ToolRegistry。
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResponse>;
  [key: string]: unknown;
}

/** Tool 执行结果（Pi AgentTool 格式） */
interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {} };
}

/** 工具依赖注入参数 */
export interface ToolDependencies {
  sendMessage: SendMessage;
  searchMemory: SearchMemory;
  storeMemory: StoreMemory;
  manageMemory: ManageMemory;
  createOtter: CreateOtter;
  dissolveOtter: DissolveOtter;
  manageKeyInfo: ManageKeyInfo;
  manageParticipant: ManageParticipant;
}

/** send_message: Otter 发送消息到对话 */
function createSendMessageTool(deps: ToolDependencies): AgentTool {
  return {
    name: "send_message",
    description: "发送消息到指定对话。参数：conversationId（对话ID），content（消息内容），senderId（发送者Otter ID），recipientId（接收者ID，通常为用户ID）",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "对话 ID" },
        content: { type: "string", description: "消息内容" },
        senderId: { type: "string", description: "发送者 Otter ID" },
        recipientId: { type: "string", description: "接收者 ID（传递说话石目标，通常为用户 ID）" },
      },
      required: ["conversationId", "content", "senderId", "recipientId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const msg = await deps.sendMessage.start({
        conversationId: params.conversationId as string,
        senderId: params.senderId as string,
        talkingStonePassedTo: [],
      });
      await deps.sendMessage.complete(msg.id, {
        body: params.content as string,
        talkingStonePassedTo: [params.recipientId as string],
      });
      return textResponse(`Message sent: ${msg.id}`);
    },
  };
}

/** pass_talking_stone: Big Otter 邀请 Small Otter 加入对话 */
function createPassTalkingStoneTool(deps: ToolDependencies): AgentTool {
  return {
    name: "pass_talking_stone",
    description: "传递说话石，邀请指定 Otter 加入对话。参数：conversationId，otterId（被邀请的Otter ID），inviterId（邀请者ID）",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        otterId: { type: "string", description: "被邀请的 Otter ID" },
        inviterId: { type: "string", description: "邀请者 Otter ID" },
      },
      required: ["conversationId", "otterId", "inviterId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const { participant } = await deps.manageParticipant.join(
        params.conversationId as string,
        params.otterId as string,
        `Otter ${params.inviterId} passed the talking stone to ${params.otterId}`,
      );
      return textResponse(`Otter ${params.otterId} joined conversation. Participant ID: ${participant.id}`);
    },
  };
}

/** search_memory: 检索记忆（渐进式披露：支持 detail_level） */
function createSearchMemoryTool(deps: ToolDependencies): AgentTool {
  return {
    name: "search_memory",
    description: "检索记忆。支持渐进式披露：detail_level 控制返回详细程度。summary 返回首句，snippet 返回匹配片段（默认），full 返回完整内容",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词" },
        limit: { type: "number", description: "最大结果数" },
        detail_level: {
          type: "string",
          enum: ["summary", "snippet", "full"],
          description: "返回内容的详细程度：summary（ID+首句+分数）、snippet（ID+匹配片段+分数+元数据，默认）、full（完整内容+元数据）",
        },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const detailLevel = (params.detail_level as "summary" | "snippet" | "full") ?? "snippet";
      const result = await deps.searchMemory.search({
        query: params.query as string,
        limit: (params.limit as number) ?? 10,
        detailLevel,
      });

      const entries = result.entries.map((e) => {
        if (detailLevel === "summary") {
          return { id: e.id, snippet: e.snippet, score: e.score, layer: e.layer };
        }
        if (detailLevel === "snippet") {
          return { id: e.id, snippet: e.snippet, score: e.score, layer: e.layer, contentType: e.contentType };
        }
        /* detailLevel === "full" */
        return { id: e.id, content: e.content, score: e.score, layer: e.layer, contentType: e.contentType, metadata: e.metadata };
      });
      return textResponse(JSON.stringify(entries));
    },
  };
}

/** get_memory_detail: 获取指定记忆条目的完整内容（渐进式披露） */
function createGetMemoryDetailTool(deps: ToolDependencies): AgentTool {
  return {
    name: "get_memory_detail",
    description: "获取指定记忆条目的完整内容。用于在 search_memory 后深入查看特定条目",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "记忆条目 ID 列表（从 search_memory 返回结果中获取）",
        },
      },
      required: ["ids"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const ids = params.ids as string[];
      const entries = await deps.manageMemory.getDetails(ids);
      return textResponse(JSON.stringify(entries.map((e) => ({
        id: e.id, content: e.content, layer: e.layer,
        contentType: e.contentType, metadata: e.metadata,
        createdAt: e.createdAt,
      }))));
    },
  };
}

/** store_memory: 存储记忆 */
function createStoreMemoryTool(deps: ToolDependencies): AgentTool {
  return {
    name: "store_memory",
    description: "存储记忆条目。参数：content（内容），otterId（存储记忆的 Otter ID），conversationId（对话ID，可选）",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "记忆内容" },
        otterId: { type: "string", description: "存储记忆的 Otter ID（用于溯源）" },
        conversationId: { type: "string", description: "关联对话 ID" },
      },
      required: ["content", "otterId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const id = await deps.storeMemory.execute({
        layer: "working",
        contentType: "conversation_summary",
        sourceId: params.otterId as string,
        sourceTable: "agent",
        conversationId: params.conversationId as string | undefined,
        granularity: "coarse",
        content: params.content as string,
      });
      return textResponse(`Memory stored: ${id}`);
    },
  };
}

/** create_otter: 创建子 Otter */
function createCreateOtterTool(deps: ToolDependencies): AgentTool {
  return {
    name: "create_otter",
    description: "创建子 Otter。参数：name，type（big/small），systemPrompt，parentOtterId",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Otter 名称" },
        type: { type: "string", enum: ["big", "small"], description: "Otter 类型" },
        systemPrompt: { type: "string", description: "系统提示词" },
        parentOtterId: { type: "string", description: "父 Otter ID" },
      },
      required: ["name", "type", "systemPrompt", "parentOtterId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const otter = await deps.createOtter.execute({
        name: params.name as string,
        type: params.type as "big" | "small",
        systemPrompt: params.systemPrompt as string,
        parentOtterId: params.parentOtterId as string,
      });
      return textResponse(`Otter created: ${otter.id} (${otter.name})`);
    },
  };
}

/** dissolve_otter: 解散 Otter */
function createDissolveOtterTool(deps: ToolDependencies): AgentTool {
  return {
    name: "dissolve_otter",
    description: "解散指定 Otter。参数：otterId",
    parameters: {
      type: "object",
      properties: {
        otterId: { type: "string", description: "要解散的 Otter ID" },
      },
      required: ["otterId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      await deps.dissolveOtter.execute(params.otterId as string);
      return textResponse(`Otter ${params.otterId} dissolved`);
    },
  };
}

/** create_linked_resource: 创建链接资源 */
function createLinkedResourceTool(deps: ToolDependencies): AgentTool {
  return {
    name: "create_linked_resource",
    description: "创建链接资源。参数：conversationId，url，title，linkedBy",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        url: { type: "string", description: "资源 URL" },
        title: { type: "string", description: "资源标题" },
        linkedBy: { type: "string", description: "链接者 Otter ID" },
      },
      required: ["conversationId", "url", "linkedBy"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const resource = await deps.manageKeyInfo.linkResource({
        conversationId: params.conversationId as string,
        resourceType: "url",
        url: params.url as string,
        title: params.title as string | undefined,
        linkedBy: params.linkedBy as string,
        autoLinked: false,
      });
      return textResponse(`Linked resource created: ${resource.id}`);
    },
  };
}

/**
 * 工具工厂：接收 use cases，产出全部 Agent Tool 实例。
 * main.ts 调用此函数并注册到 ToolRegistry。
 */
export function createTools(deps: ToolDependencies): AgentTool[] {
  return [
    createSendMessageTool(deps),
    createPassTalkingStoneTool(deps),
    createSearchMemoryTool(deps),
    createGetMemoryDetailTool(deps),
    createStoreMemoryTool(deps),
    createCreateOtterTool(deps),
    createDissolveOtterTool(deps),
    createLinkedResourceTool(deps),
  ];
}
