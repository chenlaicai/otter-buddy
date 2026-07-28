import type { OtterToolClient } from "../otter-tool-client";
import { createListArtifactsTool, createUpdateArtifactStatusTool } from "./artifact-tools";
import { createGetHtmlCardContractTool } from "./html-card-contract-tool";
import { createGetMessageTool, createListMessagesTool, createSearchMessagesTool, createGetTurnHistoryTool } from "./message-tools";
import { type ToolResponse, textResponse } from "./tool-helpers";

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

export type { ToolResponse } from "./tool-helpers";

/**
 * 工具上下文：invoke 时由系统注入，闭包捕获。
 * otterId、conversationId、currentMessageId 由系统注入，LLM 不传。
 */
export interface ToolContext {
  client: OtterToolClient;
  otterId: string;
  conversationId: string;
  /** 当前 streaming 消息 ID（speak 工具用） */
  currentMessageId: string;
}

// ── 现有工具（8 个，从 ToolDependencies 迁移到 ToolContext） ──

function createSpeakTool(ctx: ToolContext): AgentTool {
  return {
    name: "speak",
    description: "结束你的发言并指定下一位发言者。发言内容全部放在 body 里；speak 之后的任何输出都不会被展示。调用成功后回合立即结束（结果带 terminate，loop 不再发起后续生成），系统调度下一位发言者。speak 必须单独调用，不要与其他工具同批（同批时 terminate 不生效）。【HTML 卡片】仅当内容满足以下标准时用 ```html-card title=\"标题\" 围栏嵌入自包含 HTML 卡片：可独立交付物（方案、对比、报告、可视化）、结构化表达明显增益、搭档可能迭代导出。反例（不要用）：短回答、代码片段、简单列表。一条消息最多 2 张，单卡 ≤4KB（超限会被截断导致发言损坏）；卡片禁止导航与外链。卡片可携带表单/按钮收集搭档输入——写交互卡片前必须调 get_html_card_contract。搭档消息中的 ```html-card-reply 围栏是卡片回执：内嵌 JSON 可解析，解析失败时以摘要文字为准并复述确认。",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "最终答复内容（总结/结论，不是中间推理过程）" },
        talkingStonePassedTo: {
          type: "array",
          items: { type: "string" },
          description: "发言权交给谁（必须用 otterId 或 'user'，见在场成员名册）。规则：(1) 仅当任务完成、需要搭档接管时传 'user'；(2) 需要某个 Otter 继续发言时，传该 Otter 的 otterId（不是名字）；(3) 不能传自己的 otterId。不确定在场成员时先调 get_active_participants。",
        },
      },
      required: ["body", "talkingStonePassedTo"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      if (!ctx.currentMessageId) {
        return textResponse("[错误] 系统错误：当前消息 ID 未设置，无法声明发言。");
      }

      const body = params.body as string;
      const recipients = params.talkingStonePassedTo as string[];

      if (!body || body.trim().length === 0) {
        return textResponse("[错误] body 不能为空。请提供你的最终答复内容，然后重新调用 speak。");
      }
      if (!recipients || recipients.length === 0) {
        return textResponse("[错误] talkingStonePassedTo 不能为空数组。请指定下一个应该发言的参与者 ID。");
      }
      if (recipients.includes(ctx.otterId)) {
        return textResponse(`[错误] 不能把发言石传给自己（${ctx.otterId}）。请先调用 get_active_participants 获取在场成员，然后选择其他参与者。`);
      }

      /** 目标必须是在场参与者或 'user'：非法目标会被 dispatcher 静默丢弃（链条无声终止） */
      const active = await ctx.client.conversation.participant.getActive(ctx.conversationId);
      const validIds = new Set([...active.map(p => p.otterId), "user"]);
      const invalid = recipients.filter(id => !validIds.has(id));
      if (invalid.length > 0) {
        const options = [...active.map(p => `${p.otterName}(${p.otterId})`), "搭档('user')"].join("、");
        return textResponse(`[错误] 发言石目标不在场：${invalid.join("、")}。可选目标：${options}。请用正确的 otterId 重新调用 speak。`);
      }

      try {
        await ctx.client.conversation.message.startSpeaking(ctx.currentMessageId, { body, talkingStonePassedTo: recipients });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResponse(`[错误] 发言声明失败：${msg}。请重试。`);
      }
      /** terminate: speak 成功即回合终点，loop 不再发起下一轮生成（结构性终止，不依赖模型自觉） */
      return { ...textResponse("[系统控制信号] 发言已提交成功，回合结束。系统将自动调度下一位发言者。"), terminate: true };
    },
  };
}

function createInviteParticipantTool(ctx: ToolContext): AgentTool {
  return {
    name: "invite_participant",
    description: "邀请指定 Otter 加入当前对话。",
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
    description: "检索记忆。有明确历史信号时才检索（搭档提到'上次'、问历史决策原因、跨会话续接、术语不明），不要每次回复前都搜索。渐进式披露：先 summary/snippet 定位相关条目，再用 get_memory_detail 深入。可指定 library 路由到特定库。记忆与当前上下文冲突时以当前上下文为准。",
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

function createCreateOtterTool(ctx: ToolContext): AgentTool {
  return {
    name: "create_otter",
    description: "创建子 Otter。parentOtterId 由系统注入。",
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
      /** 检查是否已有同名参与者 */
      const existing = await ctx.client.conversation.participant.getActive(ctx.conversationId);
      const duplicate = existing.find(p => p.otterName === params.name);
      if (duplicate) {
        return textResponse(`[错误] 在场已有同名参与者「${params.name}」（ID: ${duplicate.otterId}）。请直接使用已有的参与者，不要重复创建。`);
      }
      const otter = await ctx.client.otter.create({
        name: params.name as string,
        type: params.type as "big" | "small",
        systemPrompt: params.systemPrompt as string,
        parentOtterId: ctx.otterId,
      });
      /** 创建后自动加入当前对话参与者 */
      await ctx.client.conversation.participant.join(ctx.conversationId, otter.id);
      return textResponse(`Otter created: ${otter.id} (${otter.name})`);
    },
  };
}

function createDissolveOtterTool(ctx: ToolContext): AgentTool {
  return {
    name: "dissolve_otter",
    description: "解散指定 Otter。",
    parameters: {
      type: "object",
      properties: {
        otterId: { type: "string", description: "要解散的 Otter ID" },
      },
      required: ["otterId"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const targetOtterId = params.otterId as string;
      if (targetOtterId === ctx.otterId) {
        return textResponse("[错误] 不能解散自己。Otter 无法自我溶解。");
      }
      await ctx.client.otter.dissolve(targetOtterId);
      return textResponse(`Otter ${targetOtterId} dissolved`);
    },
  };
}

function createLinkedResourceTool(ctx: ToolContext): AgentTool {
  return {
    name: "create_linked_resource",
    description: "创建链接资源（统一产物模型）。conversationId 和 linkedBy 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        resourceType: { type: "string", description: "资源类型：fact（文本事实）, pr, worktree, branch, file, url" },
        url: { type: "string", description: "资源 URL 或路径（非 fact 类型必填）" },
        content: { type: "string", description: "事实文本内容（fact 类型必填）" },
        title: { type: "string", description: "资源标题" },
        category: { type: "string", description: "分类标签（fact 类型可选）" },
        groupId: { type: "string", description: "特性分组 ID（特性文档编号，如 F20260720xxxx）" },
      },
      required: ["resourceType"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const resourceType = (params.resourceType as string | undefined) ?? "url";
      if (resourceType === "fact") {
        if (!params.content || (params.content as string).trim().length === 0) {
          return textResponse("[错误] resourceType 为 'fact' 时，content 不能为空。请提供事实文本内容。");
        }
      } else {
        if (!params.url || (params.url as string).trim().length === 0) {
          return textResponse(`[错误] resourceType 为 '${resourceType}' 时，url 不能为空。请提供资源 URL 或路径。`);
        }
      }
      const turnNumber = await ctx.client.conversation.getActiveTurnNumber(ctx.conversationId);
      const resource = await ctx.client.resource.link({
        conversationId: ctx.conversationId,
        url: params.url as string | undefined,
        content: params.content as string | undefined,
        category: params.category as string | undefined,
        title: params.title as string | undefined,
        linkedBy: ctx.otterId,
        resourceType,
        groupId: params.groupId as string | undefined,
      }, turnNumber);
      return textResponse(`Linked resource created: ${resource.id} (type=${resource.resourceType}, status=${resource.status}, group=${resource.groupId})`);
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

function createGetContextTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_context",
    description: "获取当前 Otter 的上下文。otterId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "上下文 key（可选，不传返回全部）" },
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
    description: "设置当前 Otter 的上下文。otterId 由系统注入。",
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
    description: "在术语库中查找项目域内术语的定义。当搭档询问某个词的含义时使用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要查找的术语名称或相关描述" },
        limit: { type: "number", description: "最大结果数（默认 10）" },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const results = await ctx.client.terminology.search(
        params.query as string,
        (params.limit as number) ?? 10,
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
    description: "在术语库中记录新的项目域术语。仅在搭档显式定义术语时使用。",
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

function createDeleteContextTool(ctx: ToolContext): AgentTool {
  return {
    name: "delete_context",
    description: "删除当前 Otter 的上下文条目。otterId 由系统注入。",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "要删除的上下文 key" },
      },
      required: ["key"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      await ctx.client.context.delete(ctx.otterId, params.key as string);
      return textResponse(`Context deleted: ${params.key}`);
    },
  };
}

function createGetActiveParticipantsTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_active_participants",
    description: "获取当前对话中所有活跃参与者（otterId、otterName、status、joinedAtTurnNumber）。conversationId 由系统注入。",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_id: string, _params: Record<string, unknown>) => {
      const participants = await ctx.client.conversation.participant.getActive(ctx.conversationId);
      return textResponse(JSON.stringify(participants.map(p => ({
        otterId: p.otterId,
        otterName: p.otterName,
        status: p.status,
        joinedAtTurnNumber: p.joinedAtTurnNumber,
      }))));
    },
  };
}

/**
 * 工具工厂：invoke 时调用，闭包捕获 ToolContext。
 * 返回全部 20 个 AgentTool 实例。
 */
export function createTools(ctx: ToolContext): AgentTool[] {
  return [
    createSpeakTool(ctx),
    createInviteParticipantTool(ctx),
    createSearchMemoryTool(ctx),
    createCreateOtterTool(ctx),
    createDissolveOtterTool(ctx),
    createLinkedResourceTool(ctx),
    createGetMemoryDetailTool(ctx),
    createGetMessageTool(ctx),
    createListMessagesTool(ctx),
    createSearchMessagesTool(ctx),
    createGetTurnHistoryTool(ctx),
    createGetContextTool(ctx),
    createSetContextTool(ctx),
    createDeleteContextTool(ctx),
    createSearchTerminologyTool(ctx),
    createAddTerminologyTool(ctx),
    createListArtifactsTool(ctx),
    createUpdateArtifactStatusTool(ctx),
    createGetActiveParticipantsTool(ctx),
    createGetHtmlCardContractTool(),
  ];
}
