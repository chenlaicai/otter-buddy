import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { stripHtmlCardsOnly } from "@entities/conversation/message-body-projection";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";

export function createGetMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_message",
    description: "按 ID 获取消息条目详情（时间线 entries）. When: 需要查看某条发言的完整内容（含 html-card 卡片全文）/状态/元数据. Not for: 搜索 → search_messages. 列表浏览 → list_messages. Output: 条目详情（sender/body/entryType/turnId/seq/timestamps）. GOTCHA: 条目不存在时返回 isError；speak/user 承载对话内容，invoke_*/yield/system 是边界与状态条目.",
    parameters: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "条目 ID（entry id）" },
      },
      required: ["messageId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      // F20260913ctlv 批4a：数据源切 entries（messages 停写——卡片全文回看源）
      const e = await ctx.client.conversation.entry.getEntryById(params.messageId as string);
      if (!e) return errorResponse(`[错误] 条目 ${params.messageId} 不存在`);
      return textResponse(JSON.stringify({
        id: e.id, senderType: e.senderType, senderId: e.senderId, entryType: e.entryType,
        body: e.body, status: e.status, turnId: e.turnId,
        sequenceNum: e.sequenceNum, createdAt: e.createdAt, completedAt: e.completedAt,
      }));
    },
  };
}

export function createListMessagesTool(ctx: ToolContext): AgentTool {
  return {
    name: "list_messages",
    description: "分页查询当前对话的时间线条目（entries 倒序）. When: 浏览历史发言 / 看对话脉络. Not for: 关键词搜索 → search_messages. Output: 分页条目列表（默认 50 条，倒序）. TIP: 先用小 limit（如 10）快速定位，不要一次拉大量. BOUNDARY: conversationId 由系统注入; HTML 卡片在列表视图剥离为占位符（看卡片全文用 get_message）; entries 单调 sequenceNum 排序天然一致（无新旧刻度混排问题）.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "最大结果数" },
        entryType: { type: "string", description: "可选过滤条目类型（user/speak/system/invoke_start/invoke_end/yield）" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      // F20260913ctlv 批4a：数据源切 entries（时间线唯一真相源，sequence_num 倒序）
      const entries = await ctx.client.conversation.entry.listEntries(ctx.conversationId, {
        limit: (params.limit as number | undefined) ?? 50,
        ...(params.entryType ? { entryType: params.entryType as string } : {}),
      });
      return textResponse(JSON.stringify(entries.map(e => ({
        id: e.id, senderType: e.senderType, senderId: e.senderId, entryType: e.entryType,
        /** 注入出口给剥离投影：html-card 替换为占位符（源码经 get_message 取回）；
         *  html-card-reply 不剥（回执 JSON 是交互载荷，须直接可见） */
        body: e.body == null || e.body.length === 0 ? null : stripHtmlCardsOnly(e.body), sequenceNum: e.sequenceNum, createdAt: e.createdAt,
      }))));
    },
  };
}

export function createSearchMessagesTool(ctx: ToolContext): AgentTool {
  return {
    name: "search_messages",
    description: "在当前对话中关键词搜索发言（FTS5 全文检索，支持中文）. When: 需要引用或核实搭档/自己之前的具体发言. Not for: 跨会话搜索 → search_memory. 浏览 → list_messages. Output: 匹配条目列表（含高亮片段）. TIP: 无结果时拆分关键词重试. 命中并实质影响回答时，在发言开头展示一行记忆溯源（格式见 SYSTEM.md R7）——查了要说，搭档需要感知记忆在干活. BOUNDARY: 仅当前对话，conversationId 由系统注入.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        limit: { type: "number", description: "最大结果数" },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      // F20260913ctlv 收尾批3：数据源切 entries_fts（时间线唯一真相源；messages_fts 停写）
      const entries = await ctx.client.conversation.entry.searchEntries(
        ctx.conversationId,
        params.query as string,
        (params.limit as number) ?? 10,
      );
      return textResponse(JSON.stringify(entries.map(e => ({
        id: e.id, senderType: e.senderType, senderId: e.senderId,
        entryType: e.entryType,
        body: e.body == null ? null : stripHtmlCardsOnly(e.body), sequenceNum: e.sequenceNum, createdAt: e.createdAt,
      }))));
    },
  };
}

export function createGetTurnHistoryTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_turn_history",
    description: "获取当前对话的 Turn 历史链. When: 理解对话回合结构 / 谁在哪个 turn 说了什么. Output: Turn 链（可选含每 turn 的条目）. TIP: includeMessages=true 看完整轨迹，false 只看骨架. BOUNDARY: conversationId 由系统注入; turns 表保留（turn 生命周期），条目内容从 entries 取.",
    parameters: {
      type: "object",
      properties: {
        includeMessages: { type: "boolean", description: "是否包含每个 Turn 的条目" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      // F20260913ctlv 批4a：turn 骨架（turns 表）+ 条目内容（entries）
      const turns = await ctx.client.conversation.getTurns(ctx.conversationId);
      const include = (params.includeMessages as boolean) ?? false;
      const result = await Promise.all(turns.map(async (turn) => ({
        turn,
        entries: include
          ? (await ctx.client.conversation.entry.getEntriesByTurnId(turn.id)).map(e => ({
            id: e.id, senderType: e.senderType, senderId: e.senderId, entryType: e.entryType,
            /** 与 list_messages 同款剥离投影（只剥 html-card，回执 JSON 保留） */
            body: e.body == null || e.body.length === 0 ? null : stripHtmlCardsOnly(e.body), sequenceNum: e.sequenceNum,
          }))
          : [],
      })));
      return textResponse(JSON.stringify(result));
    },
  };
}
