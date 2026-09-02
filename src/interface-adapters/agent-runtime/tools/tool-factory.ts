/* eslint-disable max-lines -- 合并 main 分支 contentType + recruiting createdAfter 后行数增加 */
import type { MemoryContentType } from "@entities/memory/memory-entry";
import type { EdgeType } from "@entities/memory/memory-edge";
import { createListArtifactsTool, createUpdateArtifactStatusTool } from "./artifact-tools";
import { createGetHtmlCardContractTool } from "./html-card-contract-tool";
import { createGetMessageTool, createListMessagesTool, createSearchMessagesTool, createGetTurnHistoryTool } from "./message-tools";
import { validateSpeakBody } from "./tool-helpers";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import type { HealingErrorType, HealingSeverity, HealingEventStatus } from "@entities/healing/healing-event";
import { FACT_CONTENT_MAX_LENGTH, FACT_CONTENT_TOO_LONG_MESSAGE, GROUP_ID_REQUIRED_TYPES, GROUP_ID_REQUIRED_MESSAGE_PREFIX } from "@usecases/conversation/manage-key-info";
import type { Logger } from "@usecases/ports/logger";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import { interceptHealingReport, createManageHealingEventsTool } from "./healing-tools";
import { createHaltOtterTool, createQuerySignalsTool, createResolveSignalTool, interceptSignalReport } from "./signal-tools";
import { DomainError } from "@entities/errors";
import { createWorkspaceTools } from "./workspace-tools";
import { createStockDataTool } from "./stock-tools";
import { createPaperTradeTool } from "./paper-trade-tool";
import { createCreateScheduledTaskTool } from "./scheduled-task-tools";
import type { ManageScheduledTask } from "@usecases/scheduled-task/manage-scheduled-task";
// R20260817arnt PR-A：工具契约类型自本文件上移 @usecases/ports/agent-tools（消除 frameworks 反向依赖此文件）
import type { AgentTool, ToolContext, ToolModelPool } from "@usecases/ports/agent-tools";
import type { Ledger } from "@usecases/paper-trading/ledger";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";
// R20260817arnt PR-B：领域规则下沉到 usecases 层
import { validateAndResolve } from "@usecases/conversation/talking-stone";
import { checkPendingDispatches, confirmDispatchesClear } from "@usecases/conversation/dispatch-guard";

function createSpeakTool(ctx: ToolContext, healingRepo?: HealingEventRepository, logger?: Logger): AgentTool {
  return {
    name: "speak",
    // F20260825hcpg 判断标准归位（原设计 F20260728htar L81，在 description 压缩中失传）。
    // 勿再移出：行为触发类引导必须在工具 description（每请求随 tools 参数注入，pi-ai
    // anthropic-messages.js convertTools），references 指针对「要不要用」的决策无效。
    description: "发言工具——你在聊天室里唯一的发言通道。你生成的普通文本对其他参与者不可见（搭档需点开流式过程才能看到，其他海獭完全看不到），只有 speak 输出的内容才会被所有人看到。所有需要传达给他人的内容都必须通过 speak(body) 输出。纯内容输出，不涉及行动权移交。调用后 agent loop 继续（terminate=false），可以继续调工具或再次 speak。多次调用的 body 会作为独立片段按顺序拼接为最终消息。TIP: 面向搭档的方案对比、设计思路、排查结论、结构化数据——正文先写 1-2 句结论，html-card 卡片放结构化详情，搭档更直观；短问答、代码片段、简单列表用 md。每条都出卡等于没出卡。GOTCHA: speak 不等于交棒——说完后还需调 yield 把行动权交给下一位，回合才会结束。GOTCHA: HTML 卡片（```html-card title=\"标题\"``` 围栏）必须完整写在 body 参数内——**一条消息最多 2 张，单卡 ≤8KB；写在 speak 之外文本里的卡片搭档看不到，系统会检测并拒绝该次调用**。写卡片前必须调 get_html_card_contract 获取完整契约；搭档回复中的 ```html-card-reply``` 围栏是卡片回执（内嵌 JSON 可解析）。系统自愈：见 SYSTEM.md R5——调用遇系统问题时在 body 末尾附 healing 块，顺利则附 no_issue 块。",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "发言内容（进展/结论，会即时呈现给搭档）" },
      },
      required: ["body"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      if (!ctx.currentMessageId) return errorResponse("[错误] 系统错误：当前消息 ID 未设置，无法发言。");

      const rawBody = params.body as string;
      // F20260826mwrd C2：信号块拦截（仿 healing 先例，在 cleanBody 入库前剥离+落账）
      const afterHealing = healingRepo && rawBody
        ? interceptHealingReport(rawBody, ctx, healingRepo, logger)
        : rawBody;
      const cleanBody = ctx.signalRepo && afterHealing
        ? await interceptSignalReport(afterHealing, ctx, ctx.signalRepo, logger)
        : afterHealing;

      /** F20260804hcob: 空 body + 卡片写在 speak 外的统一校验（后者：assistant 文本不持久化，搭档看不到，拒绝并指导重试） */
      const bodyError = validateSpeakBody(ctx.getTurnAssistantText?.(), cleanBody);
      if (bodyError) return errorResponse(bodyError);

      try {
        /** 拆分后 speak 只落内容（每次一条 segment，原子事务），行动权移交由 yield 负责 */
        const seg = await ctx.client.conversation.message.appendSegment(ctx.currentMessageId, cleanBody);
        return {
          ...textResponse("[系统控制信号] 已记录发言，继续工作。"),
          terminate: false,
          /** agent-invoker 检测此标记并广播 speak.intermediate SSE（前端实时展示中间发言）
           *  segmentId + sequenceNum 用于前端分段渲染（F-multi-speak-bubble） */
          details: { __speakIntermediate: true, body: cleanBody, segmentId: seg.id, sequenceNum: seg.sequenceNum },
        };
      } catch (err) {
        return errorResponse(`[错误] 发言落库失败：${err instanceof Error ? err.message : String(err)}。请重试。`);
      }
    },
  };
}

/** F20260821i336：更新派工台账状态（yield 成功后批量更新） */
async function updateDispatchLedgerOnYield(ctx: ToolContext, resolvedIds: string[]): Promise<void> {
  for (const id of resolvedIds) {
    await ctx.client.dispatch.updateRecord({
      otterId: id,
      conversationId: ctx.conversationId,
      status: 'in_progress',
    });
  }
}

/** F20260901sgp0 P0: HALT 权限校验 + 信号元数据构建（从 yield execute 中提取，降低 cyclomatic complexity） */
const VALID_SIGNAL_LEVELS = new Set(['NORMAL', 'URGENT', 'HALT']);

/** F20260901sgp0 P0: HALT 权限校验 + 信号元数据构建（从 yield execute 中提取，降低 cyclomatic complexity） */
async function resolveSignalLevel(
  ctx: ToolContext,
  levelParam: string | undefined,
  reasonParam: unknown,
  healingRepo?: HealingEventRepository
): Promise<{ signalLevel: string; signalMeta: string | undefined; haltError: string | null }> {
  const signalLevel = levelParam?.toUpperCase() ?? 'NORMAL';
  if (!VALID_SIGNAL_LEVELS.has(signalLevel)) {
    return { signalLevel, signalMeta: undefined, haltError: `[错误] 无效信号档位 "${signalLevel}"，合法值：NORMAL / URGENT / HALT` };
  }
  if (signalLevel === 'HALT') {
    const self = await ctx.client.otter.getById(ctx.otterId);
    if (self?.type === 'small') {
      if (healingRepo) {
        healingRepo.create({
          id: crypto.randomUUID(),
          messageId: ctx.currentMessageId ?? '',
          conversationId: ctx.conversationId,
          otterId: ctx.otterId,
          errorType: 'permission_denied' as HealingErrorType,
          severity: 'medium' as HealingSeverity,
          description: `小獭 ${ctx.otterId} 尝试投递 HALT 档信号，已拒绝`,
          suggestion: '需要中止任务请 yield(NORMAL) 回大獭说明情况',
          context: null,
          status: 'open' as HealingEventStatus,
          resolution: null,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        });
      }
      return {
        signalLevel,
        signalMeta: undefined,
        haltError: "[错误] 小獭不允许投递 HALT 档信号（仅用户/大獭可投，沿用 F20260826mwrd C2 裁决）。需要中止任务请 yield(NORMAL) 回大獭说明情况。",
      };
    }
  }
  const signalMeta = signalLevel !== 'NORMAL'
    ? JSON.stringify({ level: signalLevel, reason: reasonParam as string | undefined })
    : undefined;
  return { signalLevel, signalMeta, haltError: null };
}

/** 消息非空校验（从 yield execute 中提取，降低 cyclomatic complexity） */
async function validateMessageHasContent(ctx: ToolContext): Promise<string | null> {
  if (!ctx.currentMessageId) return "[错误] 系统错误：当前消息 ID 未设置，无法交棒。";
  const msg = await ctx.client.conversation.message.getById(ctx.currentMessageId);
  if (!msg || msg.segments.length === 0) return "[错误] 你还没有用 speak 输出任何内容。请先调用 speak(body) 输出结论，再调用 yield 交棒。";
  return null;
}

function createYieldTool(ctx: ToolContext, healingRepo?: HealingEventRepository): AgentTool {
  return {
    name: "yield",
    description: "交棒工具——结束你的本轮行动，把行动权交给指定的参与者。接到行动权的人会被立即唤醒执行。调用前应先用 speak 输出你的结论/成果（yield 不会携带内容）。GOTCHA: yield 必须单独调用，不要与其他工具同批（同批时 terminate 不生效）。WORKFLOW: 路由规则——子任务完成时传回召唤你的海獭或工作流下一步执行者；整个任务终审才传 'user'；不能传自己。不确定在场成员时先调 get_active_participants。\n\n⚠️ yield to 'user' 反思检查点：当 to 包含 'user' 时，请先暂停想一想——为什么需要用户介入？如果你自己能处理、或有其他人应该先确认，就不要 yield 给 user。建议通过 reason 参数说明你的理由。",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "行动权交给谁（用 Otter 的名字或 'user'，见在场成员名册）。接到行动权的人会被系统立即唤醒执行。路由规则：(1) 子任务完成时，传回召唤你的海獭（小獭默认交回召唤者）或工作流下一步的执行者——不是 'user'；(2) 整个协作任务完成、需要搭档（用户）拍板时，才传 'user'；(3) 不能传自己。",
        },
        reason: {
          type: "string",
          description: "（to 包含 'user' 时建议提供）说明为什么需要用户介入。生成理由的过程就是暂停思考的过程。",
        },
        level: {
          type: "string",
          enum: ["NORMAL", "URGENT", "HALT"],
          description: "信号档位：NORMAL（默认，必处理）/ URGENT（必决策）/ HALT（物理停，仅用户/大獭可投）",
        },
      },
      required: ["to"],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      // 消息非空校验
      const msgError = await validateMessageHasContent(ctx);
      if (msgError) return errorResponse(msgError);

      const recipients = params.to as string[];
      if (!recipients || recipients.length === 0) return errorResponse("[错误] 交棒目标不能为空。请指定下一个应该行动的参与者名字。");

      const active = await ctx.client.conversation.participant.getActive(ctx.conversationId);
      const { resolvedIds, error } = validateAndResolve(recipients, active, ctx.otterId);
      if (error) return errorResponse(error);

      /** F20260813actk C9：软守卫——未派工票据未清空时给一次提醒（非阻断，二次放行；此处不清除票据） */
      const dispatchWarning = checkPendingDispatches(ctx, resolvedIds, recipients);
      if (dispatchWarning) return textResponse(dispatchWarning);

      // F20260901sgp0 P0: 信号档位解析 + HALT 权限校验
      const { signalLevel, signalMeta, haltError } = await resolveSignalLevel(ctx, params.level as string | undefined, params.reason, healingRepo);
      if (haltError) return errorResponse(haltError);

      try {
        /** 拆分后 startSpeaking 只设路由 + 状态（内容已由 speak 的 segments 落库） */
        await ctx.client.conversation.message.startSpeaking(ctx.currentMessageId, { talkingStonePassedTo: resolvedIds, signalLevel, signalMeta });
        /** F20260813actk C9：提交成功后才确认清除已派工票据 */
        confirmDispatchesClear(ctx, resolvedIds);
        /** F20260821i336：更新派工台账状态（小獭 yield 回来时标记为 in_progress） */
        await updateDispatchLedgerOnYield(ctx, resolvedIds);
      } catch (err) {
        if (err instanceof DomainError && err.kind === "conflict") {
          return { ...textResponse("[系统控制信号] 本回合行动已交棒，无需重复调用 yield。请停止调用任何工具。"), terminate: true };
        }
        return errorResponse(`[错误] 交棒失败：${err instanceof Error ? err.message : String(err)}。请重试。`);
      }
      return { ...textResponse("[系统控制信号] 交棒成功，回合结束。"), terminate: true };
    },
  };
}

/** search_memory: 检索记忆（渐进式披露：支持 detail_level + library 路由 + 时间过滤） */
// eslint-disable-next-line max-lines-per-function -- F20260826rcmm Phase 0 加埋点后超 60 行
function createSearchMemoryTool(ctx: ToolContext): AgentTool {
  return {
    name: "search_memory",
    description: `检索记忆：跨会话的历史决策、讨论、F/R 文档与事实都在这里，是你了解一件事来龙去脉的第一入口. When: 需要历史脉络时——显性信号：搭档提到'上次'/问某决策为什么/跨会话续接/术语不明；隐性信号：收到方案/决策/排查类实质问题先自问'这事在本项目有历史脉络吗'（本项目的方案、结论、教训大多沉淀在记忆里），有则先搜再答，答案能站在已有结论上. 纯新话题/闲聊不必搜，不是为了搜而搜. Not for: 当前上下文存取 → get_context/set_context. 取记忆全文 → get_memory_detail. Output: 记忆条目列表（detail_level 三级：summary 默认快速扫描/snippet 匹配上下文/full 完整内容）+ vecCoverage（vec 索引健康度，读法：total=0 → 本路由不走 vec 索引（术语库/锚点短路/空结果），ratio 无意义；0<ratio<1 → 有暗化条目（部分记忆缺向量），召回可能不完整；vecDisabled=true → vec 路径整体降级为 FTS-only（版本锚 mismatch 等），语义近邻召回缺失、仅关键词匹配可用，重要检索可提示用户排查）+ contextEntries（expand_context=true 时的邻域上下文）. TIP: 默认走 summary → get_memory_detail 两步（见 get_memory_detail description）；结果含 drillDown 字段时按其 tool/params 调用下钻；输入 F/R 文档 ID（如 F20260812mrcq）时自动短路定位（source=anchor）；命中条目后调 get_related 沿关系图拼链（怎么读链、怎么顺着链走见其 description）；发现条目间关联用 link_memory 声明，链越拼越完整. 命中并实质影响回答时，在发言开头展示一行记忆溯源（格式见 SYSTEM.md R7）——查了要说，搭档需要感知记忆在干活. BOUNDARY: 记忆与当前上下文冲突时以当前上下文为准；可指定 library 路由 / created_after 过滤时间范围（如定时摘要查今日新增）；debug=true 返回中间分值用于诊断召回排序（F20260811mrpy）；expand_context=true 返回命中条目的前后 chunk/消息邻域（F20260812mrcq）.`,
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
      const { entries, contextEntries, vecCoverage, total } = await ctx.client.memory.search(
        params.query as string,
        (params.limit as number) ?? 10,
        detailLevel,
        params.library as string | undefined,
        params.created_after as string | undefined,
        contentType,
        params.expand_context as boolean | undefined,
      );
      // F20260826rcmm Phase 0：检索埋点（fire-and-forget，失败不影响工具返回）。
      // 挂在 tool 层而非 client 层：此处才有 per-request 的 conversationId/otterId。
      // total 用检索系统真值（非 entries.length）：区分「只找到 N 条」和「命中很多但返回 top-k」。
      // beforeMessageId = ctx.currentMessageId：上下文快照排除检索动作自身的消息（防自问自答污染标注）。
      // 同步 try/catch：client 实现内部同步抛错（如装配遗漏的 TypeError）也不得打挂工具（mimo 审视必修，测试实证）
      try {
        ctx.client.memory.logSearch({
          query: params.query as string,
          conversationId: ctx.conversationId,
          callerId: ctx.otterId,
          beforeMessageId: ctx.currentMessageId,
          detailLevel,
          library: params.library as string | undefined,
          limitCount: (params.limit as number) ?? 10,
          topEntryIds: entries.map((e) => e.id),
          total,
        });
      } catch {
        // 埋点任何形态的失败（含同步抛错）都不影响检索可用性
      }
      // F20260812mrcq Part 2: 透传 contextEntries 给 agent（不混入 entries，避免评分断层）
      // F20260821evaf 二轮审视: 透传 vecCoverage——兑现 description 承诺，agent 感知降级/暗化
      return textResponse(JSON.stringify({
        entries,
        ...(contextEntries && contextEntries.length > 0 ? { contextEntries } : {}),
        ...(vecCoverage ? { vecCoverage } : {}),
      }));
    },
  };
}

/** #543：create_otter 前置提示——目标模型近 24h 内有未恢复的配额耗尽记录时提示改派。
 *  Why 提示不硬拦：rate_limit 事件 resolve 无人驱动（配额恢复是外部事实），
 *  24h 窗内旧事件可能已恢复——硬拦会误伤；提示让编排獭结合上下文自行裁决。
 *  findAll('open', 50) 按时间倒序，rate_limit 事件正常态为 0，过滤成本可忽略。 */
async function checkModelQuotaHint(
  healingRepo: HealingEventRepository | undefined,
  targetAlias: string | undefined,
): Promise<string> {
  if (!healingRepo || !targetAlias) return '';
  try {
    const events = await healingRepo.findAll('open', 50);
    const windowMs = 24 * 3600 * 1000;
    const hit = events.find(e => {
      if (e.errorType !== 'rate_limit') return false;
      const ctx = (e.context ?? {}) as { modelAlias?: unknown; exhausted?: unknown };
      return ctx.modelAlias === targetAlias && ctx.exhausted === true
        && Date.now() - Date.parse(e.createdAt) < windowMs;
    });
    if (!hit) return '';
    return `\n⚠️ #543 提示：模型 ${targetAlias} 近 24h 内有配额耗尽记录（${hit.createdAt}）。若配额未恢复，新獭将无法执行任务（首次 invoke 即终态失败）。建议改派其他模型，或坚持创建后用小任务试探。`;
  } catch {
    return ''; // 提示性检查，失败静默降级
  }
}

function createCreateOtterTool(ctx: ToolContext, healingRepo?: HealingEventRepository): AgentTool {
  return {
    name: "create_otter",
    description: "创建子 Otter 并让它就位待命. When: 需要召唤小獭分担工作（独立审视/并行工作/角色讨论/任务分担）. **创建不触发执行——新 Otter 只是就位待命，你必须在随后的 yield 里把行动权传给它（to=[\"名字\"]），它才会被唤醒执行；只创建不派工＝小獭永远不产出**. Not for: 解散 → dissolve_otter. Output: 新 Otter 的 ID 与名称，自动加入当前对话（但未开工）. GOTCHA: 创建不可逆——在场已有同名参与者时拒绝创建（避免重名混乱）. BOUNDARY: parentOtterId 由系统注入（不可伪造血缘）. TIP: 召唤决策与 systemPrompt 编写见 otter-summon skill.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Otter 名称" },
        systemPrompt: { type: "string", description: "系统提示词" },
        modelAlias: { type: "string", description: "模型别名（可选，不传使用默认模型）。可选值见身份提示中的模型列表。" },
      },
      required: ["name", "systemPrompt"],
    },
    // eslint-disable-next-line complexity -- #543：+配额前置提示分支（校验链顺序内聚，拆分无增益）
    execute: async (_id: string, params: Record<string, unknown>) => {
      // 校验 modelAlias
      const modelAlias = params.modelAlias as string | undefined;
      if (modelAlias && modelAlias.trim().length > 0 && ctx.modelPool && !ctx.modelPool.hasModel(modelAlias)) {
        const available = ctx.modelPool.describeModels().map(m => m.alias).join(", ");
        return errorResponse(`[错误] 未知的模型别名「${modelAlias}」。可用模型：${available}`);
      }

      /** #543：目标模型近 24h 配额耗尽提示（显式 alias 用显式的，未传用默认模型；
       *  getDefaultAlias 缺失（mock/旧装配）时跳过默认模型检查——提示性功能不硬依赖） */
      const pool = ctx.modelPool as (ToolModelPool & { getDefaultAlias?: () => string }) | undefined;
      const targetAlias = modelAlias?.trim() || pool?.getDefaultAlias?.();
      const quotaHint = await checkModelQuotaHint(healingRepo, targetAlias);

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
      /** F20260821i336：创建派工台账记录 */
      await ctx.client.dispatch.createRecord({
        conversationId: ctx.conversationId,
        otterId: otter.id,
        otterName: otter.name,
        task: (params.systemPrompt as string).substring(0, 200), // 截取前 200 字符作为任务摘要
      });
      /** F20260824aibd: 回包含模型信息，让大獭对模型分配有即时反馈 */
      const config = ctx.otterConfigProvider?.getConfig(otter.id);
      const modelLabel = config?.modelAlias ? `，模型：${config.modelAlias}` : '';
      /** F20260813actk C3：回包提示就位待命状态（串行场景教育）；#543：附配额提示 */
      return textResponse(
        `Otter created: ${otter.id} (${otter.name}${modelLabel}). 已就位待命，但尚未开工——` +
        `你需要在随后的 yield 里把行动权（to=["${otter.name}"]）传给它，它才会执行。` +
        quotaHint
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

/** F20260824srst: 自重启循环防护——当前 session 是否由自重启创建（tool 层第一道防线） */
async function isSelfRestartLoop(ctx: ToolContext, healingRepo?: HealingEventRepository): Promise<boolean> {
  if (!healingRepo) return false;
  const activeSession = await ctx.client.otter.getActiveSession(ctx.otterId).catch(() => null);
  if (!activeSession) return false;
  const events = await healingRepo.findRecentByOtter(ctx.otterId, 'self_restart', 20);
  return events.some(e => {
    const ectx = e.context as { newSessionId?: string } | null;
    return ectx?.newSessionId === activeSession.id;
  });
}

/** F20260810rstart: restart_otter 工具。小獭只能重启自己，大獭可重启任意 otter。 */
function createRestartOtterTool(ctx: ToolContext, healingRepo?: HealingEventRepository): AgentTool {
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

      // F20260824srst: 自重启循环防护（第一道防线）。
      // Why 在 tool 层拦截而非 agent-invoker 层：LLM 调用 restart_otter(self) 时立即返回错误，
      // 避免设置 pendingRestart 后再由 invoker 层拦截——tool 层拦截更早、更省 token。
      if (targetOtterId === ctx.otterId && await isSelfRestartLoop(ctx, healingRepo)) {
        return errorResponse('[系统保护] 当前 session 已由自重启创建，不允许连续自重启。请通过新消息与獭交互。');
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
    description: "创建链接资源（统一产物模型）. When: 记录关键决策/事实/PR/worktree/分支/file/url 等产物. Not for: 普通对话回复 → 直接 speak. Output: 资源 ID + 状态 + group. GOTCHA: fact 类型 ≤ 500 字符；长内容（方案、设计文档）必须先用 write 写文件再创 file 资源指向路径；pr/worktree/branch 类型必须带 groupId=特性文档编号（否则报错，#580）. BOUNDARY: conversationId 和 linkedBy 由系统注入. TIP: 资源只走状态流转不删除——记录类动作完成后不再链式触发后续.",
    parameters: {
      type: "object",
      properties: {
        resourceType: { type: "string", description: "资源类型：fact（文本事实）, pr, worktree, branch, file, url" },
        url: { type: "string", description: "资源 URL 或路径（非 fact 类型必填）" },
        content: { type: "string", description: "事实文本内容（fact 必填，≤500 字符的简短摘要）" },
        title: { type: "string", description: "资源标题" },
        category: { type: "string", description: "分类标签（fact 类型可选）" },
        groupId: { type: "string", description: "特性分组 ID（特性文档编号，如 F20260720xxxx）。pr/worktree/branch 类型必填" },
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
      // F20260829gvid（#580）：pr/worktree/branch 是特性交付产物，漏传 groupId 会让 list_artifacts
      // 按组检索落空（gssf/ptun 两次检视才补的案例）。与 domain 层 validateGroupIdRequired
      // 同口径（双层校验先例：fact 长度）。纯空白视为漏传。
      if (GROUP_ID_REQUIRED_TYPES.has(resourceType)) {
        const groupId = params.groupId as string | undefined;
        if (!groupId || groupId.trim().length === 0) {
          return errorResponse(`[错误] ${GROUP_ID_REQUIRED_MESSAGE_PREFIX}。漏传会让 list_artifacts 按组检索落空（gssf/ptun 两次案例，#580）。请先用 list_artifacts 或 search_memory 查找当前对话对应的特性文档编号。`);
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
    description: `从一个记忆条目出发遍历关系图，拼证据链/因果链/发展链. When: 手里有 entry id 想深挖关联——'这事怎么来的/产出了什么/被什么取代/和什么相关'；id 典型来自 search_memory 命中（刚 sync_docs 的文档也可用文档 ID 经 search_memory 短路定位拿到）. Output: { related: [{entry, edgeType, edgeFromEntryId, depth}], provenance? }. 怎么读链：direction=out（默认）时，每项 = 从 edgeFromEntryId 沿 edgeType 指向 entry，用 edgeFromEntryId ↔ entry.id 把片段对接成链；direction=in 时，entry 就是边的起点（edgeFromEntryId 与 entry.id 相同），含义是 entry --edgeType--> 你的查询起点（depth=1）或上一跳节点（depth>1）；分叉时一个节点可能挂在多条链上. depth=1 直接邻居，depth=2 两跳间接关联. 怎么顺着链走：查'X 怎么来的'（谁催生/产出 X）→ entry_id=X + direction=in + produced；查'X 产出了什么' → direction=out + produced；查'X 被什么取代（找新版）'→ direction=in + supersedes，查'X 取代过什么（找前身）'→ direction=out + supersedes；查同主题关联 → relates-to（恒双向，direction 不影响）. provenance 仅在起点是特性/研究文档且有催生对话记录时出现，含催生对话的消息——读它可以还原'这文档是在哪段讨论里、基于什么讨论出来的'. 发现未声明的关联可用 link_memory 补上.`,
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
      // F20260824aibd: modelAlias 由 usecase 批量预取后经 HTTP DTO 透传（#446 后不再在 tool 层二次查询，
      // 原循环内逐个 getConfig 是 PR #445 填充 DTO 前的旧路径，已冗余）
      const result = participants.map(p => ({
        otterId: p.otterId,
        otterName: p.otterName,
        status: p.status,
        joinedAtTurnNumber: p.joinedAtTurnNumber,
        ...(p.modelAlias ? { modelAlias: p.modelAlias } : {}),
      }));
      return textResponse(JSON.stringify(result));
    },
  };
}

/** F20260821i336：query_dispatch_ledger — 查询派工台账，大獭汇报前核对 */
function createQueryDispatchLedgerTool(ctx: ToolContext): AgentTool {
  return {
    name: "query_dispatch_ledger",
    description: "查询派工台账. When: 大獭汇报任务状态前核对实际派工记录，消灭状态虚报. Output: 派工记录列表（otterName/task/status/PR/时间戳）. BOUNDARY: 只读不修改状态. conversationId 由系统注入.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "failed"],
          description: "按状态过滤（可选）",
        },
        otterId: {
          type: "string",
          description: "按小獭 ID 过滤（可选）",
        },
      },
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const records = await ctx.client.dispatch.queryRecords({
        conversationId: ctx.conversationId,
        status: params.status as "pending" | "in_progress" | "completed" | "failed" | undefined,
        otterId: params.otterId as string | undefined,
      });
      return textResponse(JSON.stringify(records));
    },
  };
}

// eslint-disable-next-line max-params -- PR4: paperLedger needs injection to avoid frameworks dependency
export function createTools(ctx: ToolContext, healingRepo?: HealingEventRepository, logger?: Logger, workspaceGateway?: WorkspaceGateway, manageScheduledTask?: ManageScheduledTask, paperLedger?: { ledger: Ledger; getAccountId: () => string | undefined }): AgentTool[] {
  // F20260826mwrd C1：signal 仓库经 ToolContext.signalRepo 注入（避免参数继续膨胀）
  const signalRepo = ctx.signalRepo;
  const tools: AgentTool[] = [
    createSpeakTool(ctx, healingRepo, logger),
    createYieldTool(ctx, healingRepo),
    createSearchMemoryTool(ctx),
    createCreateOtterTool(ctx, healingRepo),
    createDissolveOtterTool(ctx),
    createRestartOtterTool(ctx, healingRepo),
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
    createQueryDispatchLedgerTool(ctx),
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
  // stock_data: 无外部依赖，直接注册
  tools.push(createStockDataTool(ctx));
  // paper_trade: 纸面交易工具（注入 Ledger，避免 interface-adapters 直接依赖 frameworks）
  if (paperLedger) {
    tools.push(createPaperTradeTool(ctx, paperLedger.ledger, paperLedger.getAccountId));
  }
  // F20260826mwrd C1：halt 工具（仅 signalRepo 注入时注册；编排大獭用——
  // small 型 whitelist 不含 halt_otter，天然隔离；query_signals 两型均可用）
  if (signalRepo) {
    tools.push(createHaltOtterTool(ctx, signalRepo, logger));
    tools.push(createQuerySignalsTool(ctx, signalRepo));
    // F20260826mwrd C2：裁决写路径——resolve_signal 仅 big 型（裁决权在大獭，
    // 方案 Part 2「程序化裁决义务」的代码落点）
    tools.push(createResolveSignalTool(ctx, signalRepo));
  }
  return tools;
}
