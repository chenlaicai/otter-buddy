import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { stripHtmlCardsOnly } from "@entities/conversation/message-body-projection";
import { aggregateBody } from "@entities/conversation/message";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";

export function createGetMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_message",
    description: "按 ID 获取消息详情. When: 需要查看某条消息的完整内容/状态/元数据. Not for: 搜索消息 → search_messages. 列表浏览 → list_messages. Output: 消息详情（sender/body/status/turnId/seq/timestamps）. GOTCHA: 消息不存在时返回 isError.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "消息 ID" },
      },
      required: ["messageId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const msg = await ctx.client.conversation.message.getById(params.messageId as string);
      if (!msg) return errorResponse(`[错误] 消息 ${params.messageId} 不存在`);
      return textResponse(JSON.stringify({
        id: msg.id, senderType: msg.senderType, senderId: msg.senderId,
        body: aggregateBody(msg.segments), status: msg.status, turnId: msg.turnId,
        sequenceNum: msg.sequenceNum, createdAt: msg.createdAt, completedAt: msg.completedAt,
        ...(msg.signalLevel ? { signalLevel: msg.signalLevel } : {}),
        ...(msg.signalMeta ? { signalMeta: msg.signalMeta } : {}),
      }));
    },
  };
}

export function createListMessagesTool(ctx: ToolContext): AgentTool {
  return {
    name: "list_messages",
    description: "分页查询当前对话的消息列表. When: 浏览历史消息 / 看对话脉络. Not for: 关键词搜索 → search_messages. Output: 分页消息列表（默认 50 条，倒序）. TIP: 先用小 limit（如 10）快速定位，需要更多用 before 分页，不要一次拉大量. BOUNDARY: conversationId 由系统注入; HTML 卡片在列表视图剥离为占位符（看卡片全文用 get_message）.",
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
        /** 注入出口给剥离投影：html-card 替换为占位符（源码经 get_message 取回）；
         *  html-card-reply 不剥（回执 JSON 是交互载荷，须直接可见） */
        body: m.segments.length === 0 ? null : stripHtmlCardsOnly(aggregateBody(m.segments)), status: m.status, sequenceNum: m.sequenceNum, createdAt: m.createdAt,
        ...(m.signalLevel ? { signalLevel: m.signalLevel } : {}),
        ...(m.signalMeta ? { signalMeta: m.signalMeta } : {}),
      }))));
    },
  };
}

export function createSearchMessagesTool(ctx: ToolContext): AgentTool {
  return {
    name: "search_messages",
    description: "在当前对话中关键词搜索消息（FTS5 全文检索，支持中文）. When: 需要引用或核实搭档/自己之前的具体发言. Not for: 跨会话搜索 → search_memory. 浏览 → list_messages. Output: 匹配消息列表（含高亮片段）. TIP: 无结果时拆分关键词重试. 命中并实质影响回答时，在发言开头展示一行记忆溯源（格式见 SYSTEM.md R7）——查了要说，搭档需要感知记忆在干活. BOUNDARY: 仅当前对话，conversationId 由系统注入.",
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
        body: aggregateBody(m.segments), sequenceNum: m.sequenceNum, createdAt: m.createdAt,
        ...(m.signalLevel ? { signalLevel: m.signalLevel } : {}),
      }))));
    },
  };
}

export function createGetTurnHistoryTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_turn_history",
    description: "获取当前对话的 Turn 历史链. When: 理解对话回合结构 / 谁在哪个 turn 说了什么. Output: Turn 链（可选含每 turn 的消息）. TIP: includeMessages=true 看完整轨迹，false 只看骨架. BOUNDARY: conversationId 由系统注入.",
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
          id: m.id, senderType: m.senderType, senderId: m.senderId,
          /** 与 list_messages 同款剥离投影（只剥 html-card，回执 JSON 保留） */
          body: m.segments.length === 0 ? null : stripHtmlCardsOnly(aggregateBody(m.segments)), sequenceNum: m.sequenceNum,
        })),
      }))));
    },
  };
}
