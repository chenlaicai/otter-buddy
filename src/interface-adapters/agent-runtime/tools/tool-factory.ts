/* eslint-disable max-lines -- 合并 main 分支 contentType + recruiting createdAfter 后行数增加 */
import type { OtterToolClient } from "../otter-tool-client";
import type { MemoryContentType } from "@entities/memory/memory-entry";
import { createListArtifactsTool, createUpdateArtifactStatusTool } from "./artifact-tools";
import { createGetHtmlCardContractTool } from "./html-card-contract-tool";
import { createGetMessageTool, createListMessagesTool, createSearchMessagesTool, createGetTurnHistoryTool } from "./message-tools";
import { type ToolResponse, textResponse, errorResponse, validateSpeakBody } from "./tool-helpers";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { FACT_CONTENT_MAX_LENGTH, FACT_CONTENT_TOO_LONG_MESSAGE } from "@usecases/conversation/manage-key-info";
import type { Logger } from "@usecases/ports/logger";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import { interceptHealingReport } from "./healing-tools";
import { DomainError } from "@entities/errors";
import { createWorkspaceTools } from "./workspace-tools";


export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * 执行工具。
   * M1（R20260810piab）：signal 透传 SDK 的 AbortSignal——用户中断时工具可检查 signal.aborted 提前返回。
   * 大多数工具不需要中断（执行快），signal 参数可选；长耗时工具（如 workspace_* 操作大文件）应定期检查。
   */
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResponse>;
  [key: string]: unknown;
}

export type { ToolResponse } from "./tool-helpers";

/**
 * 模型池接口（用于工具层校验 modelAlias，不依赖 frameworks 层）。
 * 与 ModelPool 接口一致，但定义在 interface-adapters 层避免循环依赖。
 */
export interface ModelPoolLike {
  hasModel(alias: string): boolean;
  describeModels(): Array<{ alias: string; description?: string; strengths?: string[]; weaknesses?: string[] }>;
}

/**
 * 工具上下文：invoke 时由系统注入，闭包捕获。
 * otterId、conversationId、currentMessageId 由系统注入，LLM 不传。
 */
export interface ToolContext {
  client: OtterToolClient;
  otterId: string;
  conversationId: string;
  currentMessageId: string;
  /** 模型池（多模型路由，可选，用于校验 modelAlias） */
  modelPool?: ModelPoolLike;
  /**
   * 当前 assistant 消息的文本（speak 之外的输出）。
   * 由 session 工厂按消息维护（message_start 清零、message_end 累积）；speak 用它检测"卡片写在 speak 外"的错误用法。
   */
  getTurnAssistantText?: () => string;
}

/** F20260803trrf: name->id resolve（NFC 归一化），speak 改用名字，系统侧做映射 */
function resolveTalkingStoneTargets(
  recipients: string[],
  active: Array<{ otterId: string; otterName: string }>,
): { resolvedIds: string[]; invalid: string[] } {
  const byName = new Map<string, string>();
  for (const p of active) byName.set(p.otterName.normalize("NFC"), p.otterId);
  /** 用 Set 去重，防止 LLM 传重复名字导致 DB 存重复 otterId（F20260803trrf review P3） */
  const resolvedSet = new Set<string>();
  const invalid: string[] = [];
  for (const r of recipients) {
    if (r === "user") { resolvedSet.add("user"); continue; }
    const id = byName.get(r.normalize("NFC"));
    if (id) resolvedSet.add(id); else invalid.push(r);
  }
  return { resolvedIds: [...resolvedSet], invalid };
}

/** F20260803trrf: 校验 + resolve，降低 execute 复杂度 */
function validateAndResolve(
  recipients: string[],
  active: Array<{ otterId: string; otterName: string }>,
  selfOtterId: string,
): { resolvedIds: string[]; error?: string } {
  if (!recipients || recipients.length === 0) return { resolvedIds: [], error: "[错误] talkingStonePassedTo 不能为空数组。请指定下一个应该发言的参与者名字。" };
  const { resolvedIds, invalid } = resolveTalkingStoneTargets(recipients, active);
  if (resolvedIds.includes(selfOtterId)) {
    const myName = active.find(p => p.otterId === selfOtterId)?.otterName ?? selfOtterId;
    return { resolvedIds: [], error: `[错误] 不能把发言石传给自己（${myName}）。请选择其他参与者。` };
  }
  if (invalid.length > 0) {
    const options = [...active.map(p => p.otterName), "搭档('user')"].join("、");
    return { resolvedIds: [], error: `[错误] 发言石目标不在场：${invalid.join("、")}。可选目标：${options}。请用正确的名字重新调用 speak。` };
  }
  return { resolvedIds };
}

function createSpeakTool(ctx: ToolContext, healingRepo?: HealingEventRepository, logger?: Logger): AgentTool {
  return {
    name: "speak",
    description: "结束你的发言并指定下一位发言者。发言内容全部放在 body 里——speak 之外的任何输出（之前或之后）都不会进入消息，搭档看不到。调用成功后回合立即结束（terminate=true），系统调度下一位发言者。GOTCHA: speak 必须单独调用，不要与其他工具同批（同批时 terminate 不生效）。GOTCHA: HTML 卡片（```html-card title=\"标题\"``` 围栏）必须完整写在 body 参数内——一条消息最多 2 张，单卡 ≤4KB；写在 speak 之外文本里的卡片搭档看不到，系统会检测并拒绝该次调用。写卡片前必须调 get_html_card_contract 获取完整契约；搭档回复中的 ```html-card-reply``` 围栏是卡片回执（内嵌 JSON 可解析）。WORKFLOW: 路由规则——子任务完成时传回召唤你的海獭或工作流下一步执行者；整个任务终审才传 'user'；不能传自己。系统自愈：调用遇系统问题时在 body 末尾附 `<healing>[issues]` 块（type/severity/description/suggestion 各一行），顺利则附 `<healing>[no_issue]</healing>`——标记会被系统自动剥离。",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "最终答复内容（总结/结论，不是中间推理过程）" },
        talkingStonePassedTo: {
          type: "array",
          items: { type: "string" },
          description: "发言权交给谁（用 Otter 的名字或 'user'，见在场成员名册）。路由规则：(1) 子任务完成时，传回召唤你的海獭（小獭默认交回召唤者）或工作流下一步的执行者——不是 'user'；(2) 整个协作任务完成、需要搭档（用户）拍板时，才传 'user'；(3) 不能传自己。不确定在场成员时先调 get_active_participants。",
        },
      },
      required: ["body", "talkingStonePassedTo"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      if (!ctx.currentMessageId) return errorResponse("[错误] 系统错误：当前消息 ID 未设置，无法声明发言。");

      const rawBody = params.body as string;
      const recipients = params.talkingStonePassedTo as string[];
      const cleanBody = healingRepo && rawBody
        ? interceptHealingReport(rawBody, ctx, healingRepo, logger)
        : rawBody;

      /** F20260804hcob: 空 body + 卡片写在 speak 外的统一校验（后者：assistant 文本不持久化，搭档看不到，拒绝并指导重试） */
      const bodyError = validateSpeakBody(ctx.getTurnAssistantText?.(), cleanBody);
      if (bodyError) return errorResponse(bodyError);

      const active = await ctx.client.conversation.participant.getActive(ctx.conversationId);
      const { resolvedIds, error } = validateAndResolve(recipients, active, ctx.otterId);
      if (error) return errorResponse(error);

      try {
        await ctx.client.conversation.message.startSpeaking(ctx.currentMessageId, { body: cleanBody, talkingStonePassedTo: resolvedIds });
      } catch (err) {
        if (err instanceof DomainError && err.kind === "conflict") {
          return { ...textResponse("[系统控制信号] 本回合发言已提交，无需重复调用 speak。请停止调用任何工具。"), terminate: true };
        }
        return errorResponse(`[错误] 发言声明失败：${err instanceof Error ? err.message : String(err)}。请重试。`);
      }
      return { ...textResponse("[系统控制信号] 发言已提交成功，回合结束。系统将自动调度下一位发言者。"), terminate: true };
    },
  };
}

function createInviteParticipantTool(ctx: ToolContext): AgentTool {
  return {
    name: "invite_participant",
    description: "邀请指定 Otter 加入当前对话. When: 需要拉入不在场的 Otter 加入协作时. Not for: 创建新 Otter → create_otter. 解散 → dissolve_otter. Output: 参与者加入成功的确认. GOTCHA: 被邀请的 Otter 必须已存在（用 create_otter 创建过），否则加入失败.",
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

/** search_memory: 检索记忆（渐进式披露：支持 detail_level + library 路由 + 时间过滤） */
function createSearchMemoryTool(ctx: ToolContext): AgentTool {
  return {
    name: "search_memory",
    description: `检索记忆。有明确历史信号时才检索（搭档提到'上次'、问历史决策原因、跨会话续接、术语不明），不要每次回复前都搜索。

渐进式披露工作流（默认策略）：
1. 首次搜索用 detail_level="summary"，快速扫描哪些条目相关
2. 看中特定条目后，用 get_memory_detail 传入 ID 获取完整内容
3. 只在需要匹配上下文片段时用 detail_level="snippet"
4. detail_level="full" 仅用于明确需要一次性获取全文的场景（如批量导出）

记忆与当前上下文冲突时以当前上下文为准。可指定 library 路由到特定库；可指定 created_after 过滤时间范围（如定时摘要查今日新增）。`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词" },
        limit: { type: "number", description: "最大结果数" },
        detail_level: {
          type: "string",
          enum: ["summary", "snippet", "full"],
          description: "渐进式披露：summary=ID+首句+分数（快速扫描，推荐首选）、snippet=ID+匹配片段+分数+元数据（看上下文）、full=完整内容+元数据（仅需全文时用）。默认 summary。",
        },
        library: {
          type: "string",
          description: "指定库 key（如 conversation、terminology），不传则全库搜索",
        },
        created_after: {
          type: "string",
          description: "ISO timestamp（如 2026-08-04T00:00:00Z），仅返回此时间之后创建的记忆。定时摘要等场景用此过滤'今日新增'。",
        },
        content_type: {
          type: "array",
          items: {
            type: "string",
            enum: ["message", "fact", "linked_resource", "feature", "feature_chunk", "research", "research_chunk"],
          },
          description: "按内容类型过滤（多选）。feature=文档概要、feature_chunk=文档分段片段、research=研究概要、research_chunk=研究分段片段、message=对话消息、fact=事实、linked_resource=链接资源。如只搜文档正文片段传 [\"feature_chunk\"]",
        },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const detailLevel = (params.detail_level as "summary" | "snippet" | "full") ?? "summary";
      const contentType = params.content_type as MemoryContentType[] | undefined;
      const entries = await ctx.client.memory.search(
        params.query as string,
        (params.limit as number) ?? 10,
        detailLevel,
        params.library as string | undefined,
        params.created_after as string | undefined,
        contentType,
      );
      return textResponse(JSON.stringify(entries));
    },
  };
}

function createCreateOtterTool(ctx: ToolContext): AgentTool {
  return {
    name: "create_otter",
    description: "创建子 Otter. When: 需要召唤专门执行特定任务的小獭（独立审视/并行工作/角色讨论/任务分担）. Not for: 邀请已存在的 Otter 加入 → invite_participant. 解散 → dissolve_otter. Output: 新 Otter 的 ID 与名称，自动加入当前对话. GOTCHA: 创建不可逆——在场已有同名参与者时拒绝创建（避免重名混乱）. BOUNDARY: parentOtterId 由系统注入（不可伪造血缘）. TIP: 召唤决策与 systemPrompt 编写见 otter-summon skill.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Otter 名称" },
        systemPrompt: { type: "string", description: "系统提示词" },
        modelAlias: { type: "string", description: "模型别名（可选，不传使用默认模型）。可选值见身份提示中的模型列表。" },
      },
      required: ["name", "systemPrompt"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      // 校验 modelAlias
      const modelAlias = params.modelAlias as string | undefined;
      if (modelAlias && modelAlias.trim().length > 0 && ctx.modelPool && !ctx.modelPool.hasModel(modelAlias)) {
        const available = ctx.modelPool.describeModels().map(m => m.alias).join(", ");
        return errorResponse(`[错误] 未知的模型别名「${modelAlias}」。可用模型：${available}`);
      }

      /** 检查是否已有同名参与者 */
      const existing = await ctx.client.conversation.participant.getActive(ctx.conversationId);
      const duplicate = existing.find(p => p.otterName === params.name);
      if (duplicate) {
        return errorResponse(`[错误] 在场已有同名参与者「${params.name}」（ID: ${duplicate.otterId}）。请直接使用已有的参与者，不要重复创建。`);
      }
      const otter = await ctx.client.otter.create({
        name: params.name as string,
        type: "small" as const,
        systemPrompt: params.systemPrompt as string,
        parentOtterId: ctx.otterId,
        modelAlias: modelAlias?.trim() || undefined,
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
    description: "解散指定 Otter. When: 小獭任务完成不再需要 / 需要清理临时召唤的 Otter. Not for: 重启 Otter（保留身份换 session）→ restart_otter. 创建 → create_otter. Output: 解散成功的确认（含 participant 记录更新警告）. GOTCHA: **解散不可逆**——session 和上下文永久丢失，无法恢复. GOTCHA: 不能解散自己（Otter 无法自我溶解，会留下孤儿 session）. dissolve 后 participant 记录若未更新仅留警告（不阻断，otter 已销毁）.",
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
        return errorResponse("[错误] 不能解散自己。Otter 无法自我溶解。");
      }
      await ctx.client.otter.dissolve(targetOtterId);
      /** F20260803trrf: 顺带更新 participant status。leave 失败不阻断 dissolve（otter 已销毁不可逆），仅附警告。 */
      let warning = "";
      try {
        await ctx.client.conversation.participant.leave(ctx.conversationId, targetOtterId);
      } catch {
        warning = "（警告：participant 记录未更新，名册可能残留）";
      }
      return textResponse(`Otter ${targetOtterId} dissolved${warning}`);
    },
  };
}

/** F20260810rstart: restart_otter 工具。小獭只能重启自己，大獭可重启任意 otter。 */
function createRestartOtterTool(ctx: ToolContext): AgentTool {
  return {
    name: "restart_otter",
    description: "重启指定 Otter 的獭生——封存当前 Session（前世），以全新上下文开启新一世. When: Otter 上下文污染需要重置 / 退化熔断触发 / 显式要求重启. Not for: 解散 Otter（销毁身份）→ dissolve_otter. Output: 新 Session ID 确认. GOTCHA: **前世 session 封存不可逆**——新世上下文为空，靠 summary 注入；不传 summary 则新世从零开始. BOUNDARY: 访问控制——小獭只能重启自己，大獭可重启任意 Otter.",
    parameters: {
      type: "object",
      properties: {
        otterId: {
          type: "string",
          description: "要重启的 Otter ID。省略或为空则重启自己。大獭可传入任意 Otter ID。",
        },
        summary: {
          type: "string",
          description: "前情摘要，将作为新一世的上下文注入。简要说明重启原因。",
        },
      },
      required: [],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const targetOtterId = (params.otterId as string) || ctx.otterId;
      const summary = params.summary as string | undefined;

      // 访问控制：获取调用者类型
      const self = await ctx.client.otter.getById(ctx.otterId);
      const isSmallOtter = self?.type === "small";

      // 小獭只能重启自己
      if (isSmallOtter && targetOtterId !== ctx.otterId) {
        return errorResponse("[错误] 小獭只能重启自己的獭生，不能重启其他 Otter。");
      }

      // 校验目标 otter 存在性（避免孤儿 session 或 FK violation）
      const target = await ctx.client.otter.getById(targetOtterId);
      if (!target) {
        return errorResponse(`[错误] 目标 Otter ${targetOtterId} 不存在或已解散。`);
      }

      const session = await ctx.client.otter.restart(targetOtterId, summary);
      return textResponse(`Otter ${targetOtterId} 已重启獭生。新 Session ID: ${session.id}`);
    },
  };
}

function createLinkedResourceTool(ctx: ToolContext): AgentTool {
  return {
    name: "create_linked_resource",
    description: "创建链接资源（统一产物模型）. When: 记录关键决策/事实/PR/worktree/分支/file/url 等产物. Not for: 普通对话回复 → 直接 speak. Output: 资源 ID + 状态 + group. GOTCHA: fact 类型 ≤ 500 字符；长内容（方案、设计文档）必须先用 write 写文件再创 file 资源指向路径. BOUNDARY: conversationId 和 linkedBy 由系统注入. TIP: 资源只走状态流转不删除——记录类动作完成后不再链式触发后续.",
    parameters: {
      type: "object",
      properties: {
        resourceType: { type: "string", description: "资源类型：fact（文本事实）, pr, worktree, branch, file, url" },
        url: { type: "string", description: "资源 URL 或路径（非 fact 类型必填）" },
        content: { type: "string", description: "事实文本内容（fact 必填，≤500 字符的简短摘要）" },
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
          return errorResponse("[错误] resourceType 为 'fact' 时，content 不能为空。请提供事实文本内容。");
        }
        const content = params.content as string;
        if (content.length > FACT_CONTENT_MAX_LENGTH) {
          return errorResponse(`[错误] ${FACT_CONTENT_TOO_LONG_MESSAGE}`);
        }
      } else {
        if (!params.url || (params.url as string).trim().length === 0) {
          return errorResponse(`[错误] resourceType 为 '${resourceType}' 时，url 不能为空。请提供资源 URL 或路径。`);
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

/** get_memory_detail: 获取指定记忆条目的完整内容（渐进式披露第二阶段，支持批量） */
function createGetMemoryDetailTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_memory_detail",
    description: "渐进式披露第二阶段：获取指定记忆条目的完整内容。在 search_memory（summary 模式）扫到相关条目后，用此工具传入 ID 获取全文。支持批量查询。不要跳过 search_memory 直接用此工具。",
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
    description: "获取当前对话所有活跃参与者. When: 需要知道场上有谁、可用什么名字传发言石. Output: otterId / otterName / status / joinedAtTurnNumber 列表. BOUNDARY: 只读不修改状态. conversationId 由系统注入. TIP: speak 的 talkingStonePassedTo 用 otterName; invite/dissolve 用 otterId.",
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

export function createTools(ctx: ToolContext, healingRepo?: HealingEventRepository, logger?: Logger, workspaceGateway?: WorkspaceGateway): AgentTool[] {
  const tools: AgentTool[] = [
    createSpeakTool(ctx, healingRepo, logger),
    createInviteParticipantTool(ctx),
    createSearchMemoryTool(ctx),
    createCreateOtterTool(ctx),
    createDissolveOtterTool(ctx),
    createRestartOtterTool(ctx),
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
  if (workspaceGateway) {
    tools.push(...createWorkspaceTools(ctx, workspaceGateway));
  }
  return tools;
}
