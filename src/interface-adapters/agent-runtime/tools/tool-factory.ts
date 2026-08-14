/* eslint-disable max-lines -- 合并 main 分支 contentType + recruiting createdAfter 后行数增加 */
import type { OtterToolClient } from "../otter-tool-client";
import type { MemoryContentType } from "@entities/memory/memory-entry";
import type { EdgeType } from "@entities/memory/memory-edge";
import { createListArtifactsTool, createUpdateArtifactStatusTool } from "./artifact-tools";
import { createGetHtmlCardContractTool } from "./html-card-contract-tool";
import { createGetMessageTool, createListMessagesTool, createSearchMessagesTool, createGetTurnHistoryTool } from "./message-tools";
import { type ToolResponse, textResponse, errorResponse, validateSpeakBody } from "./tool-helpers";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { FACT_CONTENT_MAX_LENGTH, FACT_CONTENT_TOO_LONG_MESSAGE } from "@usecases/conversation/manage-key-info";
import type { Logger } from "@usecases/ports/logger";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import { interceptHealingReport, createManageHealingEventsTool } from "./healing-tools";
import { DomainError } from "@entities/errors";
import { createWorkspaceTools } from "./workspace-tools";
import { createCreateScheduledTaskTool } from "./scheduled-task-tools";
import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";


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
  /**
   * F20260815rstrt: 自重启时由 restart_otter 工具设置。
   * PiSessionFactory 在 session.prompt() 返回后检查并执行重启。
   * Why: session.prompt() 是原子的，中途无法替换 session；
   * 延迟到 prompt 完成后执行，消息生命周期不受影响。
   */
  pendingRestart?: { summary?: string };
  /**
   * F20260813actk C9：本轮待派工票据（otterId → otterName）。
   * create_otter 创建后注册；speak 派工后清除已覆盖的；未清空时 speak 给一次软提醒（非阻断）。
   * agent invoke 级生命周期（每次 invoke 新建）。可选——未注入时 C9 no-op。
   */
  pendingDispatches?: Map<string, string>;
  /** F20260813actk C9：本轮是否已展示过派工提醒。避免软守卫死循环——首次提醒后二次 speak 放行。 */
  dispatchWarningShown?: boolean;
}

/**
 * F20260813actk C9：待派工票据的软守卫——检查未派工并提醒（不清除票据）。
 * 若本轮创建的小獭仍有未获行动权的、且本次未提醒过，返回提醒文案（调用方以 terminate=false 返回）。
 * 返回 null 表示无需提醒，可正常提交 speak。
 *
 * 票据清除不在此函数做——移到 startSpeaking 成功后（confirmDispatchesClear）。
 * 若按"意图"提前清除，startSpeaking 失败（如 db locked）会泄漏票据：大獭重试 speak(user) 不再被提醒。
 *
 * 同批调用限制：SDK 默认并行执行同批工具。create_otter 与 speak 同批调用时，
 * create_otter 的 pendingDispatches.set() 可能晚于 speak 的检查执行——C9 只可靠
 * 覆盖串行调用场景（create 先完成返回，speak 后调用）。同批 create+speak(to user)
 * 由 prompt 层（C8 description + C1 skill 工作流 + C2 reframe）保证大獭不产生该路径。
 */
function checkPendingDispatches(
  ctx: ToolContext,
  resolvedIds: string[],
  recipients: string[],
): string | null {
  const pending = ctx.pendingDispatches;
  if (!pending) return null;
  const remaining = [...pending.entries()].filter(([id]) => !resolvedIds.includes(id));
  if (remaining.length === 0 || ctx.dispatchWarningShown) return null;
  const names = remaining.map(([, name]) => name).join("、");
  ctx.dispatchWarningShown = true;
  return (
    `[系统状态] 你本轮创建的小獭还有 ${remaining.length} 只未获得行动权：${names}。它们不会被唤醒执行。` +
    `如果你确实要把行动权交给 [${recipients.join("、")}]，再次调用 speak 即可放行；` +
    `如果是漏派，请把 ${names} 加入 talkingStonePassedTo 后重新调用 speak。`
  );
}

/** F20260813actk C9：startSpeaking 提交成功后确认清除已派工票据（按"提交成功"清，非按"意图"清） */
function confirmDispatchesClear(ctx: ToolContext, resolvedIds: string[]): void {
  const pending = ctx.pendingDispatches;
  if (!pending) return;
  for (const id of resolvedIds) pending.delete(id);
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
    return { resolvedIds: [], error: `[错误] 不能把行动权传给自己（${myName}）。请选择其他参与者。` };
  }
  if (invalid.length > 0) {
    const options = [...active.map(p => p.otterName), "搭档('user')"].join("、");
    return { resolvedIds: [], error: `[错误] 行动权目标不在场：${invalid.join("、")}。可选目标：${options}。请用正确的名字重新调用 speak。` };
  }
  return { resolvedIds };
}

function createSpeakTool(ctx: ToolContext, healingRepo?: HealingEventRepository, logger?: Logger): AgentTool {
  return {
    name: "speak",
    description: "结束你的本轮行动（思考、调工具、出结论都在这里），并指定下一位行动者——接到行动权的人会被立即唤醒执行。发言内容全部放在 body 里——speak 之外的任何输出（之前或之后）都不会进入消息，搭档看不到。调用成功后回合立即结束（terminate=true）。GOTCHA: speak 必须单独调用，不要与其他工具同批（同批时 terminate 不生效）。GOTCHA: HTML 卡片（```html-card title=\"标题\"``` 围栏）必须完整写在 body 参数内——一条消息最多 2 张，单卡 ≤4KB；写在 speak 之外文本里的卡片搭档看不到，系统会检测并拒绝该次调用。写卡片前必须调 get_html_card_contract 获取完整契约；搭档回复中的 ```html-card-reply``` 围栏是卡片回执（内嵌 JSON 可解析）。WORKFLOW: 路由规则——子任务完成时传回召唤你的海獭或工作流下一步执行者；整个任务终审才传 'user'；不能传自己。系统自愈：见 SYSTEM.md R5——调用遇系统问题时在 body 末尾附 healing 块，顺利则附 no_issue 块。",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "最终答复内容（总结/结论，不是中间推理过程）" },
        talkingStonePassedTo: {
          type: "array",
          items: { type: "string" },
          description: "行动权（旧称：发言权/发言石）交给谁（参数名 talkingStonePassedTo 即行动权令牌；用 Otter 的名字或 'user'，见在场成员名册）。接到行动权的人会被系统立即唤醒执行。路由规则：(1) 子任务完成时，传回召唤你的海獭（小獭默认交回召唤者）或工作流下一步的执行者——不是 'user'；(2) 整个协作任务完成、需要搭档（用户）拍板时，才传 'user'；(3) 不能传自己。不确定在场成员时先调 get_active_participants。",
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

      /** F20260813actk C9：软守卫——未派工票据未清空时给一次提醒（非阻断，二次放行；此处不清除票据） */
      const dispatchWarning = checkPendingDispatches(ctx, resolvedIds, recipients);
      if (dispatchWarning) return textResponse(dispatchWarning);

      try {
        await ctx.client.conversation.message.startSpeaking(ctx.currentMessageId, { body: cleanBody, talkingStonePassedTo: resolvedIds });
        /** F20260813actk C9：提交成功后才确认清除已派工票据 */
        confirmDispatchesClear(ctx, resolvedIds);
      } catch (err) {
        if (err instanceof DomainError && err.kind === "conflict") {
          return { ...textResponse("[系统控制信号] 本回合发言已提交，无需重复调用 speak。请停止调用任何工具。"), terminate: true };
        }
        return errorResponse(`[错误] 发言声明失败：${err instanceof Error ? err.message : String(err)}。请重试。`);
      }
      return { ...textResponse("[系统控制信号] 发言已提交成功，回合结束。"), terminate: true };
    },
  };
}

/** search_memory: 检索记忆（渐进式披露：支持 detail_level + library 路由 + 时间过滤） */
function createSearchMemoryTool(ctx: ToolContext): AgentTool {
  return {
    name: "search_memory",
    description: `检索记忆：跨会话的历史决策、讨论、F/R 文档与事实都在这里，是你了解一件事来龙去脉的第一入口. When: 需要历史脉络时——显性信号：搭档提到'上次'/问某决策为什么/跨会话续接/术语不明；隐性信号：收到方案/决策/排查类实质问题先自问'这事在本项目有历史脉络吗'（本项目的方案、结论、教训大多沉淀在记忆里），有则先搜再答，答案能站在已有结论上. 纯新话题/闲聊不必搜，不是为了搜而搜. Not for: 当前上下文存取 → get_context/set_context. 取记忆全文 → get_memory_detail. Output: 记忆条目列表（detail_level 三级：summary 默认快速扫描/snippet 匹配上下文/full 完整内容）+ vecCoverage（vec 索引覆盖率，ratio<1.0 说明有暗化条目，召回可能不完整）+ contextEntries（expand_context=true 时的邻域上下文）. TIP: 默认走 summary → get_memory_detail 两步（见 get_memory_detail description）；结果含 drillDown 字段时按其 tool/params 调用下钻；输入 F/R 文档 ID（如 F20260812mrcq）时自动短路定位（source=anchor）；命中条目后调 get_related 沿关系图拼链（怎么读链、怎么顺着链走见其 description）；发现条目间关联用 link_memory 声明，链越拼越完整. BOUNDARY: 记忆与当前上下文冲突时以当前上下文为准；可指定 library 路由 / created_after 过滤时间范围（如定时摘要查今日新增）；debug=true 返回中间分值用于诊断召回排序（F20260811mrpy）；expand_context=true 返回命中条目的前后 chunk/消息邻域（F20260812mrcq）.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词（F/R 文档 ID 会自动短路定位）" },
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
        expand_context: {
          type: "boolean",
          description: "开启邻域扩展：命中 chunk 时返回前后 chunk（chunk_index ±1），命中 message 时返回前后消息。结果在 contextEntries 字段（不混入 entries）。适用于需要理解命中条目上下文的场景（F20260812mrcq）。",
        },
      },
      required: ["query"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const detailLevel = (params.detail_level as "summary" | "snippet" | "full") ?? "summary";
      const contentType = params.content_type as MemoryContentType[] | undefined;
      const { entries, contextEntries } = await ctx.client.memory.search(
        params.query as string,
        (params.limit as number) ?? 10,
        detailLevel,
        params.library as string | undefined,
        params.created_after as string | undefined,
        contentType,
        params.expand_context as boolean | undefined,
      );
      // F20260812mrcq Part 2: 透传 contextEntries 给 agent（不混入 entries，避免评分断层）
      return textResponse(JSON.stringify(
        contextEntries && contextEntries.length > 0 ? { entries, contextEntries } : entries,
      ));
    },
  };
}

function createCreateOtterTool(ctx: ToolContext): AgentTool {
  return {
    name: "create_otter",
    description: "创建子 Otter 并让它就位待命. When: 需要召唤小獭分担工作（独立审视/并行工作/角色讨论/任务分担）. **创建不触发执行——新 Otter 只是就位待命，你必须在随后的 speak 里把行动权（talkingStonePassedTo）传给它，它才会被唤醒执行；只创建不派工＝小獭永远不产出**. Not for: 解散 → dissolve_otter. Output: 新 Otter 的 ID 与名称，自动加入当前对话（但未开工）. GOTCHA: 创建不可逆——在场已有同名参与者时拒绝创建（避免重名混乱）. BOUNDARY: parentOtterId 由系统注入（不可伪造血缘）. TIP: 召唤决策与 systemPrompt 编写见 otter-summon skill.",
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
      /** F20260813actk C9：注册待派工票据，供 speak 软守卫检测 */
      ctx.pendingDispatches?.set(otter.id, otter.name);
      /** F20260813actk C3：回包提示就位待命状态（串行场景教育） */
      return textResponse(
        `Otter created: ${otter.id} (${otter.name}). 已就位待命，但尚未开工——` +
        `你需要在随后的 speak 里把行动权（talkingStonePassedTo=["${otter.name}"]）传给它，它才会执行。`
      );
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

      // F20260815rstrt: 自重启时延迟执行——session.prompt() 是原子的，
      // 中途 restart 会打断 LLM 生成。标记 pending，prompt 完成后由 PiSessionFactory 执行。
      if (targetOtterId === ctx.otterId) {
        ctx.pendingRestart = { summary };
        return textResponse(
          `已标记重启当前獭生。当前发言完成后将自动执行。` +
          (summary ? ` 前情摘要：${summary}` : '')
        );
      }

      // 重启别人：直接执行（不涉及自身 session）
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
    description: "渐进式披露第二阶段：按 ID 获取记忆条目完整内容. When: search_memory(summary) 扫到相关条目后取全文. Not for: 跳过 search_memory 直接用（ID 无来源）. Output: 记忆条目全文（批量支持）. TIP: 默认走 search_memory → get_memory_detail 两步，不要跳过首步.",
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

/** F20260813mren Part 3: link_memory — LLM 声明两个记忆条目之间的关系 */
function createLinkMemoryTool(ctx: ToolContext): AgentTool {
  return {
    name: "link_memory",
    description: `声明两个记忆条目之间的关系. When: 你判断两条记忆有产出/引用/取代/相关关系时调用——典型时机：文档创建完成后（当前讨论 produced 本文档）、回答引用了历史决策时（当前发言 references 历史条目）、发现跨会话同主题时（relates-to）. type: produced(A产出B, 如消息催生文档)/references(A引用B)/supersedes(A取代B)/relates-to(双向相关). 关系一旦声明可被 get_related 遍历拼链. BOUNDARY: 不能对文档 chunk（feature_chunk/research_chunk）建边——sync 会替换 chunk 导致边丢失；消息/文档 summary/fact 均可. 幂等：同 from+to+type 重复调用返回已存在 id.`,
    parameters: {
      type: "object",
      properties: {
        from_id: { type: "string", description: "起点记忆条目 ID" },
        to_id: { type: "string", description: "终点记忆条目 ID" },
        type: {
          type: "string",
          enum: ["produced", "references", "supersedes", "relates-to"],
          description: "produced=A产出B | references=A引用B | supersedes=A取代B | relates-to=双向相关",
        },
        note: { type: "string", description: "关系备注（可选，如'这段讨论催生了F文档X的实现决策'）" },
      },
      required: ["from_id", "to_id", "type"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const result = await ctx.client.memory.linkMemory(
          {
            fromId: params.from_id as string,
            toId: params.to_id as string,
            edgeType: params.type as "produced" | "references" | "supersedes" | "relates-to",
            note: params.note as string | undefined,
          },
          ctx.otterId,
        );
        return textResponse(JSON.stringify({ edgeId: result.edgeId, linked: true }));
      } catch (err) {
        return errorResponse(`建边失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** F20260813mren Part 3: get_related — BFS 遍历关系图，返回结构化 path */
function createGetRelatedTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_related",
    description: `从一个记忆条目出发遍历关系图，拼证据链/因果链/发展链. When: 手里有 entry id 想深挖关联——'这事怎么来的/产出了什么/被什么取代/和什么相关'；id 典型来自 search_memory 命中，sync_docs / link_memory 返回的 id 同样可用. Output: { related: [{entry, edgeType, edgeFromEntryId, depth}], provenance? }. 怎么读链：related 是路径片段集合，每项 = 从 edgeFromEntryId 沿 edgeType 指向 entry；用 edgeFromEntryId ↔ entry.id 把片段对接成链，分叉时一个节点可能挂在多条链上. depth=1 直接邻居，depth=2 两跳间接关联. 怎么顺着链走：查'X 怎么来的'（谁催生/产出 X）→ entry_id=X + direction=in + produced；查'X 产出了什么' → direction=out + produced；查'X 被什么取代（找新版）'→ direction=in + supersedes，查'X 取代过什么（找前身）'→ direction=out + supersedes；查同主题关联 → relates-to（恒双向，direction 不影响）. provenance 仅在起点是特性/研究文档时出现，含催生对话的消息——读它可以还原'这文档是在哪段讨论里、基于什么讨论出来的'. 发现未声明的关联可用 link_memory 补上.`,
    parameters: {
      type: "object",
      properties: {
        entry_id: { type: "string", description: "起点记忆条目 ID" },
        depth: { type: "number", description: "BFS 遍历深度，默认 1（直接邻居），2=两跳" },
        types: {
          type: "array",
          items: { type: "string", enum: ["produced", "references", "supersedes", "relates-to"] },
          description: "过滤边类型（可选，不传则全部）",
        },
        direction: {
          type: "string",
          enum: ["out", "in"],
          description: "out=出边(A→谁,默认), in=入边(谁→A,如查谁催生了本文档)",
        },
        limit: { type: "number", description: "最大结果数，默认 20" },
      },
      required: ["entry_id"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const results = await ctx.client.memory.getRelated({
        entryId: params.entry_id as string,
        depth: params.depth as number | undefined,
        edgeTypes: params.types as EdgeType[] | undefined,
        direction: params.direction as "out" | "in" | undefined,
        limit: params.limit as number | undefined,
      });
      // F20260813mren Part 2: 若起点是 feature/research 文档，附带 provenance（催生它的对话消息）
      // 审视二轮：输出 schema 统一为 { related, provenance? }——消二态，LLM 不用面对两种结构
      const provenance = await ctx.client.memory.getDocProvenance(params.entry_id as string);
      return textResponse(JSON.stringify({
        related: results,
        ...(provenance.conversationId ? { provenance } : {}),
      }));
    },
  };
}

/** F20260813mren 审视二轮: sync_docs — 写完文档立即同步入库（不等重启） */
function createSyncDocsTool(ctx: ToolContext): AgentTool {
  return {
    name: "sync_docs",
    description: `同步特性/研究文档入库. When: 刚写完或修改了 docs/features/ 或 docs/research/ 下的文档——不调的话要等系统重启才会入库（search_memory 搜不到、provenance 不可查）. Output: { synced, updated, skipped, archived, errors } 同步统计. TIP: 写完文档后建议顺手 sync_docs + link_memory（当前讨论 produced 本文档），文档立即可检索且关系链成型. BOUNDARY: 在 worktree 里写文档时必须传 root_dir=worktree 绝对路径（默认扫主仓根，扫不到 worktree 里刚写的文档）；并发调用会返回'同步进行中'，稍后重试即可.`,
    parameters: {
      type: "object",
      properties: {
        root_dir: { type: "string", description: "扫描根目录绝对路径。在 worktree 中写文档时传 worktree 路径（如 /path/to/.claude/worktrees/xxx）；不传默认主仓根" },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        const stats = await ctx.client.docs.sync(params.root_dir as string | undefined);
        return textResponse(JSON.stringify(stats));
      } catch (err) {
        return errorResponse(`[错误] 文档同步失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** F20260813mren Part 3: unlink_memory — 删除关系边（纠错用） */
function createUnlinkEdgeTool(ctx: ToolContext): AgentTool {
  return {
    name: "unlink_memory",
    description: `删除一条关系边. When: 发现之前声明的 link_memory 有误（如类型搞错、方向搞反）. BOUNDARY: 删的是边不是条目本身. 幂等：删不存在的 edge_id 不报错.`,
    parameters: {
      type: "object",
      properties: {
        edge_id: { type: "string", description: "要删除的边 ID（从 link_memory 返回或 get_related 结果获取）" },
      },
      required: ["edge_id"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      try {
        await ctx.client.memory.unlinkEdge(params.edge_id as string);
        return textResponse(JSON.stringify({ deleted: true }));
      } catch (err) {
        return errorResponse(`删边失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

function createGetContextTool(ctx: ToolContext): AgentTool {
  return {
    name: "get_context",
    description: "获取当前 Otter 的上下文（key-value 存储）. When: 需要读取自己之前存的上下文（如任务进度、临时变量）. Output: 全部上下文或指定 key 的值. BOUNDARY: otterId 由系统注入，只读自己的上下文. TIP: 不传 key 返回全部.",
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
    description: "设置当前 Otter 的上下文键值对. When: 需要持久化任务进度/临时变量，供后续轮次读取. Not for: 长期记忆 → search_memory/create_linked_resource. Output: 设置成功确认. BOUNDARY: otterId 由系统注入. TIP: 适合存下轮要用的中间状态.",
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
    description: "在术语库中查找项目域内术语的定义. When: 搭档询问某词含义 / 需确认术语对齐时. Not for: 一般知识问答. Output: 术语定义 + 别名 + 分类 + 上下文. TIP: 频繁出现的不明词先查这里再问搭档.",
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
        return textResponse("未找到相关术语（搜索成功，零匹配——搭档可换关键词重试或 add_terminology 入库新术语）");
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
    description: "在术语库中记录新的项目域术语. When: 搭档显式定义新术语（如「我们约定 X 表示 Y」）. Not for: 自己揣测术语 → 不入库. Output: 术语入库确认（含 ID）. GOTCHA: 必须搭档显式定义——自己揣测的术语会污染术语库.",
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
    description: "删除当前 Otter 的指定上下文 key. When: 上下文过期 / 任务结束清理中间状态. Output: 删除确认. BOUNDARY: otterId 由系统注入. GOTCHA: 删除不可逆，确认 key 无用再删.",
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
    description: "获取当前对话所有活跃参与者. When: 需要知道场上有谁、可用什么名字传行动权. Output: otterId / otterName / status / joinedAtTurnNumber 列表. BOUNDARY: 只读不修改状态. conversationId 由系统注入. TIP: speak 的 talkingStonePassedTo 用 otterName; invite/dissolve 用 otterId.",
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

export function createTools(ctx: ToolContext, healingRepo?: HealingEventRepository, logger?: Logger, workspaceGateway?: WorkspaceGateway, manageScheduledTask?: ManageScheduledTask): AgentTool[] {
  const tools: AgentTool[] = [
    createSpeakTool(ctx, healingRepo, logger),
    createSearchMemoryTool(ctx),
    createCreateOtterTool(ctx),
    createDissolveOtterTool(ctx),
    createRestartOtterTool(ctx),
    createLinkedResourceTool(ctx),
    createGetMemoryDetailTool(ctx),
    createLinkMemoryTool(ctx),
    createGetRelatedTool(ctx),
    createUnlinkEdgeTool(ctx),
    createSyncDocsTool(ctx),
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
  /** F20260811sktp 第五轮审视：manage_healing_events 此前未注册（pre-existing bug），
   *  但本 PR SYSTEM.md R5 显式引用了它，必须确保运行时可用。 */
  if (healingRepo) {
    tools.push(createManageHealingEventsTool(ctx, healingRepo));
  }
  if (workspaceGateway) {
    tools.push(...createWorkspaceTools(ctx, workspaceGateway));
  }
  if (manageScheduledTask) {
    tools.push(createCreateScheduledTaskTool(ctx, manageScheduledTask));
  }
  return tools;
}
