import type { AgentTool, ToolContext, ToolResponse } from "./tool-factory";

function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }], details: {} };
}

export function createGetMessageTool(ctx: ToolContext): AgentTool {
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
        id: msg.id, senderType: msg.senderType, senderId: msg.senderId,
        body: msg.body, status: msg.status, turnId: msg.turnId,
        sequenceNum: msg.sequenceNum, createdAt: msg.createdAt, completedAt: msg.completedAt,
      }));
    },
  };
}

export function createListMessagesTool(ctx: ToolContext): AgentTool {
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
        id: m.id, senderType: m.senderType, senderId: m.senderId,
        body: m.body, status: m.status, sequenceNum: m.sequenceNum, createdAt: m.createdAt,
      }))));
    },
  };
}

export function createSearchMessagesTool(ctx: ToolContext): AgentTool {
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
        id: m.id, senderType: m.senderType, senderId: m.senderId,
        body: m.body, sequenceNum: m.sequenceNum, createdAt: m.createdAt,
      }))));
    },
  };
}

export function createGetTurnHistoryTool(ctx: ToolContext): AgentTool {
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
          id: entry.turn.id, turnNumber: entry.turn.turnNumber,
          status: entry.turn.status, createdAt: entry.turn.createdAt, closedAt: entry.turn.closedAt,
        },
        messages: entry.messages.map(m => ({
          id: m.id, senderType: m.senderType, senderId: m.senderId, body: m.body, sequenceNum: m.sequenceNum,
        })),
      }))));
    },
  };
}
