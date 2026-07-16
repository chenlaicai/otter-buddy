import type { OtterToolClient } from "../otter-tool-client";

/**
 * Agent 工具类型（与 Pi AgentTool 接口兼容）。
 * name + description + parameters + execute(toolCallId, params) => ToolResponse。
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

/**
 * 工具上下文：invoke 时由系统注入，闭包捕获。
 * otterId 和 conversationId 由系统注入，LLM 不传。
 */
export interface ToolContext {
  client: OtterToolClient;
  otterId: string;
  conversationId: string;
}

// ── 现有工具（8 个，从 ToolDependencies 迁移到 ToolContext） ──

function createSendMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: "send_message",
    description: "发送消息到当前对话。参数：content（消息内容），recipientId（接收者ID，通常为用户ID）。conversationId 和 senderId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "消息内容" },
        recipientId: { type: "string", description: "接收者 ID（传递说话石目标，通常为用户 ID）" },
      },
      required: ["content", "recipientId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const msg = await ctx.client.conversation.message.send({
        conversationId: ctx.conversationId,
        senderId: ctx.otterId,
        body: params.content as string,
        talkingStonePassedTo: [params.recipientId as string],
      });
      return textResponse(`Message sent: ${msg.id}`);
    },
  };
}

function createPassTalkingStoneTool(ctx: ToolContext): AgentTool {
  return {
    name: "pass_talking_stone",
    description: "传递说话石，邀请指定 Otter 加入当前对话。参数：otterId（被邀请的Otter ID）。",
    parameters: {
      type: "object",
      properties: {
        otterId: { type: "string", description: "被邀请的 Otter ID" },
      },
      required: ["otterId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const participant = await ctx.client.conversation.participant.join(
        ctx.conversationId,
        params.otterId as string,
      );
      return textResponse(`Otter ${params.otterId} joined conversation. Participant ID: ${participant.id}`);
    },
  };
}

/** search_memory: 检索记忆（渐进式披露：支持 detail_level + library 路由） */
function createSearchMemoryTool(ctx: ToolContext): AgentTool {
  return {
    name: "search_memory",
    description: "检索记忆。支持渐进式披露：detail_level 控制返回详细程度。summary 返回首句，snippet 返回匹配片段（默认），full 返回完整内容。可指定 library 路由到特定库",
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
        library: {
          type: "string",
          description: "指定库 key（如 conversation、terminology），不传则全库搜索",
        },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const detailLevel = (params.detail_level as "summary" | "snippet" | "full") ?? "snippet";
      const entries = await ctx.client.memory.search(
        params.query as string,
        (params.limit as number) ?? 10,
        detailLevel,
        params.library as string | undefined,
      );
      return textResponse(JSON.stringify(entries));
    },
  };
}

function createStoreMemoryTool(ctx: ToolContext): AgentTool {
  return {
    name: "store_memory",
    description: "存储记忆条目。参数：content（内容）。conversationId 和 otterId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "记忆内容" },
      },
      required: ["content"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const id = await ctx.client.memory.store({
        content: params.content as string,
        otterId: ctx.otterId,
        conversationId: ctx.conversationId,
      });
      return textResponse(`Memory stored: ${id}`);
    },
  };
}

function createCreateOtterTool(ctx: ToolContext): AgentTool {
  return {
    name: "create_otter",
    description: "创建子 Otter。参数：name，type（big/small），systemPrompt。parentOtterId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Otter 名称" },
        type: { type: "string", enum: ["big", "small"], description: "Otter 类型" },
        systemPrompt: { type: "string", description: "系统提示词" },
      },
      required: ["name", "type", "systemPrompt"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const otter = await ctx.client.otter.create({
        name: params.name as string,
        type: params.type as "big" | "small",
        systemPrompt: params.systemPrompt as string,
        parentOtterId: ctx.otterId,
      });
      return textResponse(`Otter created: ${otter.id} (${otter.name})`);
    },
  };
}

function createDissolveOtterTool(ctx: ToolContext): AgentTool {
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
      await ctx.client.otter.dissolve(params.otterId as string);
      return textResponse(`Otter ${params.otterId} dissolved`);
    },
  };
}

function createLinkedResourceTool(ctx: ToolContext): AgentTool {
  return {
    name: "create_linked_resource",
    description: "创建链接资源。参数：url，title（可选）。conversationId 和 linkedBy 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "资源 URL" },
        title: { type: "string", description: "资源标题" },
      },
      required: ["url"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const resource = await ctx.client.resource.link({
        conversationId: ctx.conversationId,
        url: params.url as string,
        title: params.title as string | undefined,
        linkedBy: ctx.otterId,
      });
      return textResponse(`Linked resource created: ${resource.id}`);
    },
  };
}

/** get_memory_detail: 获取指定记忆条目的完整内容（渐进式披露，支持批量） */
function createGetMemoryDetailTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_memory_detail",
    description: "获取指定记忆条目的完整内容。用于在 search_memory 后深入查看特定条目。支持批量查询。",
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
      const entries = await ctx.client.memory.getDetails(ids);
      return textResponse(JSON.stringify(entries));
    },
  };
}

// ── 新增工具（6 个） ──

function createGetMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_message",
    description: "按 ID 获取消息详情。参数：messageId",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "消息 ID" },
      },
      required: ["messageId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const msg = await ctx.client.conversation.message.getById(params.messageId as string);
      if (!msg) return textResponse(`Message ${params.messageId} not found`);
      return textResponse(JSON.stringify({
        id: msg.id,
        senderType: msg.senderType,
        senderId: msg.senderId,
        body: msg.body,
        status: msg.status,
        turnId: msg.turnId,
        sequenceNum: msg.sequenceNum,
        createdAt: msg.createdAt,
        completedAt: msg.completedAt,
      }));
    },
  };
}

function createListMessagesTool(ctx: ToolContext): AgentTool {
  return {
    name: "list_messages",
    description: "分页查询当前对话的消息列表。参数：limit（最大条数，默认50），before（消息ID，查询此消息之前的消息）。conversationId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "最大结果数" },
        before: { type: "string", description: "此消息 ID 之前的消息" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const messages = await ctx.client.conversation.message.list(ctx.conversationId, {
        limit: params.limit as number | undefined,
        before: params.before as string | undefined,
      });
      return textResponse(JSON.stringify(messages.map(m => ({
        id: m.id,
        senderType: m.senderType,
        senderId: m.senderId,
        body: m.body,
        status: m.status,
        sequenceNum: m.sequenceNum,
        createdAt: m.createdAt,
      }))));
    },
  };
}

function createSearchMessagesTool(ctx: ToolContext): AgentTool {
  return {
    name: "search_messages",
    description: "在当前对话中关键词搜索消息。参数：query（搜索关键词），limit（最大结果数，默认10）。conversationId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        limit: { type: "number", description: "最大结果数" },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const messages = await ctx.client.conversation.message.search(
        ctx.conversationId,
        params.query as string,
        (params.limit as number) ?? 10,
      );
      return textResponse(JSON.stringify(messages.map(m => ({
        id: m.id,
        senderType: m.senderType,
        senderId: m.senderId,
        body: m.body,
        sequenceNum: m.sequenceNum,
        createdAt: m.createdAt,
      }))));
    },
  };
}

function createGetTurnHistoryTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_turn_history",
    description: "获取当前对话的 Turn 历史链。参数：includeMessages（是否包含每个 Turn 的消息，默认 false）。conversationId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        includeMessages: { type: "boolean", description: "是否包含每个 Turn 的消息" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const history = await ctx.client.conversation.message.getTurnHistory(
        ctx.conversationId,
        { includeMessages: (params.includeMessages as boolean) ?? false },
      );
      return textResponse(JSON.stringify(history.map(entry => ({
        turn: {
          id: entry.turn.id,
          turnNumber: entry.turn.turnNumber,
          status: entry.turn.status,
          createdAt: entry.turn.createdAt,
          closedAt: entry.turn.closedAt,
        },
        messages: entry.messages.map(m => ({
          id: m.id,
          senderType: m.senderType,
          senderId: m.senderId,
          body: m.body,
          sequenceNum: m.sequenceNum,
        })),
      }))));
    },
  };
}

function createGetContextTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_context",
    description: "获取当前 Otter 的上下文。参数：key（可选，不传则返回全部上下文）。otterId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "上下文 key（可选）" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const context = await ctx.client.context.get(
        ctx.otterId,
        params.key as string | undefined,
      );
      return textResponse(JSON.stringify(context));
    },
  };
}

function createSetContextTool(ctx: ToolContext): AgentTool {
  return {
    name: "set_context",
    description: "设置当前 Otter 的上下文。参数：key, value。otterId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "上下文 key" },
        value: { type: "string", description: "上下文 value" },
      },
      required: ["key", "value"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      await ctx.client.context.set(
        ctx.otterId,
        params.key as string,
        params.value as string,
      );
      return textResponse(`Context set: ${params.key} = ${params.value}`);
    },
  };
}

// ── 术语库工具（2 个） ──

/** search_terminology: 在术语库中查找项目域内术语的定义 */
function createSearchTerminologyTool(ctx: ToolContext): AgentTool {
  return {
    name: "search_terminology",
    description: "在术语库中查找项目域内术语的定义。当用户询问某个词的含义时使用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要查找的术语名称或相关描述" },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const results = await ctx.client.terminology.search(
        params.query as string,
        10,
      );
      if (results.length === 0) {
        return textResponse("未找到相关术语");
      }
      const entries = results.map((e) => ({
        term: e.term,
        definition: e.definition,
        aliases: e.aliases,
        category: e.category,
        context: e.context,
      }));
      return textResponse(JSON.stringify(entries));
    },
  };
}

/** add_terminology: 在术语库中记录新的项目域术语 */
function createAddTerminologyTool(ctx: ToolContext): AgentTool {
  return {
    name: "add_terminology",
    description: "在术语库中记录新的项目域术语。仅在用户显式定义术语时使用。",
    parameters: {
      type: "object",
      properties: {
        term: { type: "string", description: "术语名称" },
        definition: { type: "string", description: "术语定义" },
        aliases: { type: "array", items: { type: "string" }, description: "别名列表（可选）" },
        category: { type: "string", description: "分类（可选）：实体、操作、机制等" },
        context: { type: "string", description: "上下文说明（可选）" },
      },
      required: ["term", "definition"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const entry = await ctx.client.terminology.addTerm({
        term: params.term as string,
        definition: params.definition as string,
        aliases: params.aliases as string[] | undefined,
        category: params.category as string | undefined,
        context: params.context as string | undefined,
      });
      return textResponse(`术语已记录: ${entry.term} (${entry.id})`);
    },
  };
}

/**
 * 工具工厂：invoke 时调用，闭包捕获 ToolContext。
 * 返回全部 16 个 AgentTool 实例（8 现有 + 6 新增 + 2 术语库）。
 */
export function createTools(ctx: ToolContext): AgentTool[] {
  return [
    // 现有工具（8 个）
    createSendMessageTool(ctx),
    createPassTalkingStoneTool(ctx),
    createSearchMemoryTool(ctx),
    createStoreMemoryTool(ctx),
    createCreateOtterTool(ctx),
    createDissolveOtterTool(ctx),
    createLinkedResourceTool(ctx),
    createGetMemoryDetailTool(ctx),
    // 新增工具（6 个）
    createGetMessageTool(ctx),
    createListMessagesTool(ctx),
    createSearchMessagesTool(ctx),
    createGetTurnHistoryTool(ctx),
    createGetContextTool(ctx),
    createSetContextTool(ctx),
    // 术语库工具（2 个）
    createSearchTerminologyTool(ctx),
    createAddTerminologyTool(ctx),
  ];
}
