import type { SendMessage } from "@usecases/conversation/send-message";
import type { SearchMemory } from "@usecases/memory/search-memory";
import type { StoreMemory } from "@usecases/memory/store-memory";
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
  createOtter: CreateOtter;
  dissolveOtter: DissolveOtter;
  manageKeyInfo: ManageKeyInfo;
  manageParticipant: ManageParticipant;
}

/** send_message: Otter 发送消息到对话 */
function createSendMessageTool(deps: ToolDependencies): AgentTool {
  return {
    name: "send_message",
    description: "发送消息到指定对话。参数：conversationId（对话ID），content（消息内容），senderId（发送者ID）",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "对话 ID" },
        content: { type: "string", description: "消息内容" },
        senderId: { type: "string", description: "发送者 Otter ID" },
      },
      required: ["conversationId", "content", "senderId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const msg = await deps.sendMessage.start({
        conversationId: params.conversationId as string,
        senderId: params.senderId as string,
        talkingStonePassedTo: [],
      });
      await deps.sendMessage.complete(msg.id, {
        body: params.content as string,
        talkingStonePassedTo: ["user"],
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

/** search_memory: 检索记忆 */
function createSearchMemoryTool(deps: ToolDependencies): AgentTool {
  return {
    name: "search_memory",
    description: "检索记忆。参数：query（检索关键词），limit（最大结果数，默认10）",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词" },
        limit: { type: "number", description: "最大结果数" },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const result = await deps.searchMemory.search({
        query: params.query as string,
        limit: (params.limit as number) ?? 10,
      });
      return textResponse(JSON.stringify(result.entries.map((e) => ({
        id: e.id, content: e.content, score: e.score, layer: e.layer,
      }))));
    },
  };
}

/** store_memory: 存储记忆 */
function createStoreMemoryTool(deps: ToolDependencies): AgentTool {
  return {
    name: "store_memory",
    description: "存储记忆条目。参数：content（内容），conversationId（对话ID，可选）",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "记忆内容" },
        conversationId: { type: "string", description: "关联对话 ID" },
      },
      required: ["content"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const id = await deps.storeMemory.execute({
        layer: "working",
        contentType: "conversation_summary",
        sourceId: crypto.randomUUID(),
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
    createStoreMemoryTool(deps),
    createCreateOtterTool(deps),
    createDissolveOtterTool(deps),
    createLinkedResourceTool(deps),
  ];
}
