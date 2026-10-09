/**
 * Healing 相关工具：系统自愈报告解析和 healing event 管理。
 */

import type { HealingEventRepository, HealingEventBatchFilter } from "@usecases/healing/healing-event-repository";
import type { HealingResolutionAction, HealingEventStatus, HealingErrorType } from "@entities/healing/healing-event";
import { parseHealingReport, stripHealingReport } from "@usecases/healing/healing-report-parser";
import { healingAlertRegistry } from "@usecases/healing/healing-alert-registry";
import { isHealingProbeEvent } from "@usecases/healing/constants";
import type { Logger } from "@usecases/ports/logger";
import type { ToolContext, AgentTool, ToolResponse } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";

/** 解析并剥离 healing report，返回清理后的 body */
export function interceptHealingReport(rawBody: string, ctx: ToolContext, repo: HealingEventRepository, logger?: Logger): string {
  const cleanBody = stripHealingReport(rawBody);
  const { hasIssues, issues } = parseHealingReport(rawBody);
  if (hasIssues) {
    const now = new Date().toISOString();
    const meta = { otterId: ctx.otterId, conversationId: ctx.conversationId, messageId: ctx.currentMessageId };
    for (const issue of issues) {
      if (issue.severity === 'high') {
        logger?.warn('High severity healing event', { type: issue.type, description: issue.description });
        // F20260826mwrd C3（Part 4）：high 事件不再止步于日志——登记待提醒，
        // 大獭下一次 invoke 的 dynamicContext 注入（台账照旧落 healing_events）。
        // 键用 conversationId（对话粒度队列）：消费侧（agent-invoker）按对话取全部，
        // 大獭不在场则滞留到下一轮，不丢。eventId 先行生成、与台账 create 同源
        // （fire-and-forget 双写各自失败不阻塞对方，审计面以 healing_events 为准）。
        healingAlertRegistry.enqueue(ctx.conversationId, {
          eventId: crypto.randomUUID(),
          conversationId: ctx.conversationId,
          otterId: ctx.otterId,
          errorType: issue.type,
          description: issue.description,
          createdAt: now,
        });
      }
      repo.create({
        id: crypto.randomUUID(), messageId: ctx.currentMessageId, conversationId: ctx.conversationId,
        otterId: ctx.otterId, errorType: issue.type, severity: issue.severity,
        description: issue.description, suggestion: issue.suggestion,
        context: meta, status: 'open', resolution: null, createdAt: now, resolvedAt: null,
      }).catch(err => logger?.error('Failed to store healing event', err instanceof Error ? err : new Error(String(err))));
    }
  }
  return cleanBody;
}

/** ISO 8601 日期校验——非法格式静默参与字典序比较会语义意外（检视獭-454 发现 3） */
function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Why: Date.parse 对宽松格式（如 "2026-8-1"）也返回有效值，用正则锁定 yyyy-MM-ddTHH:mm:ss 格式
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?$/.test(value) && !isNaN(Date.parse(value));
}

/** 创建 healing event 管理工具 */
async function handleBatchResolve(
  params: Record<string, unknown>,
  healingRepo: HealingEventRepository,
): Promise<ToolResponse> {
  // Why: 日期参数格式校验——非法输入会静默参与字典序比较导致语义意外
  for (const key of ['filterCreatedBefore', 'filterCreatedAfter']) {
    const val = params[key];
    if (val !== undefined && !isValidIsoTimestamp(val)) {
      return errorResponse(`[错误] ${key} 必须是 ISO 8601 时间戳（如 2026-08-25T00:00:00Z），收到：${val}`);
    }
  }
  const filter: HealingEventBatchFilter = {
    status: (params.filterStatus as string as HealingEventStatus) ?? 'open',
    errorType: params.filterErrorType as HealingErrorType | undefined,
    createdBefore: params.filterCreatedBefore as string | undefined,
    createdAfter: params.filterCreatedAfter as string | undefined,
    // #1271（F20261008hbbd）：ruleId / boundIssue 透传——修复合入后的收尾环：
    // batch_resolve + filterBoundIssue=<N> 把该 issue 归口的事件族批量终结。
    // ⚠️ 未传 filterBoundIssue 时强制 boundIssue: null（更新面与探测面对称，r1-S1）：
    // 否则普通批量（如「清理残留」型 filterErrorType 批处置）会把已归口 high 顺带静默
    // 终结——bind≠resolve 生命周期被后门击穿（已归口事件必须走显式 filterBoundIssue=N
    // 收尾，收尾动作本身就是「修复合入已验证」的声明）
    ruleId: params.filterRuleId as string | undefined,
    boundIssue: (params.filterBoundIssue as number | null | undefined) ?? null,
  };
  const resolution = {
    action: ((params.resolutionAction as string) ?? 'no_action') as HealingResolutionAction,
    decidedBy: 'agent' as const,
    decidedAt: new Date().toISOString(),
    notes: (params.resolutionNotes as string) ?? '',
  };
  const dryRun = (params.dryRun as boolean) ?? false;

  if (dryRun) {
    const result = await healingRepo.batchResolveByFilter(filter, resolution, { dryRun: true });
    return textResponse(JSON.stringify({ dryRun: true, matched: result.matched }, null, 2));
  }

  // F20261008gfrc（三步走③·裁决摩擦）：匹配集中含 high severity 时拒绝批量 resolve——
  // high 事件（变体重试计数升级类）是「正当诉求无出路」的升级信号，一键静默
  // 会把它淹没在批量处置里。先 count 高危数，>0 则 errorResponse 逼逐条处置（逐条
  // resolve 不受本闸限制——摩擦加在批量面，不是禁止处置本身）。
  // Why 工具层而非 SQL 层：闸语义是「拒绝批量、引导逐条」的交互约束，repo 层保持纯数据操作；
  // count 用独立方法而非 findAll（100 条上限的 findAll 对 >100 匹配集会漏检 high）。
  // ⚠️ countByFilter 探测不设 LIMIT 是闸正确性关键——若加 LIMIT 与更新面「对齐」会让
  // >100 匹配集的 high 漏检 → 闸失效（更新面 LIMIT 是事务分批语义，探测面必须全量）。
  // #1271（F20261008hbbd）闸豁免：只数未归口 high（boundIssue: null 叠加探测）——已归口
  // （bind 到 issue）的 high 不计入闸。「无出路」的前提已不成立：bind 把升级信号送进了
  // 结构化跟踪面（#1361 层3 的预期路径），修复合入后 batch_resolve + filterBoundIssue
  // 是它的设计内收尾环；禁它批量终结 = high 事件族永久堆积（正是 #1271 要治的病）。
  // 用户显式传 filterBoundIssue=N 时更新面已限定在已归口域（bound_issue=N 与 IS NULL
  // 矛盾 → 探测面必空），直接跳过探测；不传或传 null 时叠加 IS NULL 数未归口 high。
  // 未归口 high 仍然全量拦截——闸的本体语义不变。
  const highCount = filter.boundIssue != null
    ? 0
    : await healingRepo.countByFilter({ ...filter, severity: 'high', boundIssue: null });
  if (highCount > 0) {
    return errorResponse(
      `[错误] 匹配集中含 ${highCount} 条 high severity 事件——high 是升级信号（变体重试计数升级），禁止批量静默。` +
      `请先 query 定位这些事件逐条处置（action=resolve/dismiss 带 eventIds 不受此限）；` +
      `确认批量面安全后，可用 filterErrorType/filterCreatedBefore 等收窄 filter 避开 high 再批量。`,
    );
  }

  const result = await healingRepo.batchResolveByFilter(filter, resolution, { limit: 100 });
  return textResponse(JSON.stringify({
    matched: result.matched, resolved: result.resolved,
    resolvedIds: result.resolvedIds, resolutionNotes: resolution.notes,
    // Why: truncated 让 LLM 知道还有剩余未处置，需再次执行
    truncated: result.truncated, totalMatched: result.totalMatched,
  }, null, 2));
}

/** #1271（F20261008hbbd）：batch_bind——按 filter 批量归口到 GitHub issue（bind≠resolve）。
 *  照 RHI handleBatchBind 模式（#1052 同类问题先例）：issueNumber 必填 + filter 至少一个
 *  条件（防异质归口——无过滤全量 bind 会把不相关事件族归到同一 issue）。
 *  语义：只作用未归口 open；bind 后事件保持 open（归口≠处置，终态走 resolve）；
 *  high 不设闸（与 batch_resolve 相反且有意为之）——#1361 层3 恰要求「high 必须
 *  bind_issue 归口，不得直接 dismiss/resolve」：归口把升级信号推向结构化跟踪面，
 *  不是静默它的反面。 */
async function handleBatchBind(
  params: Record<string, unknown>,
  healingRepo: HealingEventRepository,
): Promise<ToolResponse> {
  const issueNumber = params.issueNumber as number | undefined;
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return errorResponse('[错误] issueNumber 必填且必须是正整数（GitHub issue 编号）');
  }
  // 防异质归口：至少一个过滤条件（对齐 RHI batch_bind 的最低门槛）。
  // guard_intercept 事件族标准归口法：filterErrorType=guard_intercept + filterRuleId=<指纹>
  if (!params.filterErrorType && !params.filterRuleId && !params.filterSeverity) {
    return errorResponse(
      '[错误] batch_bind 需要至少一个过滤条件（filterErrorType / filterRuleId / filterSeverity）——防异质归口。' +
      'guard_intercept 事件族按 filterErrorType=guard_intercept + filterRuleId=<ruleId 指纹> 分组归口',
    );
  }
  for (const key of ['filterCreatedBefore', 'filterCreatedAfter']) {
    const val = params[key];
    if (val !== undefined && !isValidIsoTimestamp(val)) {
      return errorResponse(`[错误] ${key} 必须是 ISO 8601 时间戳（如 2026-08-25T00:00:00Z），收到：${val}`);
    }
  }
  const filter: HealingEventBatchFilter = {
    // bind 只作用 open——归口已处置事件无意义；repo 层双保险强制
    status: 'open',
    errorType: params.filterErrorType as HealingErrorType | undefined,
    ruleId: params.filterRuleId as string | undefined,
    severity: params.filterSeverity as 'low' | 'medium' | 'high' | undefined,
    createdBefore: params.filterCreatedBefore as string | undefined,
    createdAfter: params.filterCreatedAfter as string | undefined,
  };
  const dryRun = (params.dryRun as boolean) ?? false;

  if (dryRun) {
    const result = await healingRepo.batchBindIssue(filter, issueNumber, { dryRun: true });
    return textResponse(JSON.stringify({ dryRun: true, matched: result.matched, issueNumber }, null, 2));
  }

  const result = await healingRepo.batchBindIssue(filter, issueNumber, { limit: 100 });
  return textResponse(JSON.stringify({
    matched: result.matched, bound: result.bound, boundIds: result.boundIds,
    issueNumber,
    // Why: truncated 让 LLM 知道还有剩余未归口，需再次执行（100/批）
    truncated: result.truncated, totalMatched: result.totalMatched,
  }, null, 2));
}

/** #751：query 动作——查池 + 可选 errorType 过滤 + 默认探针过滤（includeProbe 诊断通道） */
async function handleQuery(params: Record<string, unknown>, healingRepo: HealingEventRepository): Promise<ToolResponse> {
  const status = (params.status as string) ?? 'open';
  let events = await healingRepo.findAll(status as 'open' | 'resolved' | 'dismissed', 50);
  const et = params.errorType as string | undefined;
  if (et) events = events.filter(e => e.errorType === et);
  // #751：默认过滤健康探针事件（哨兵 messageId/conversationId/otterId = probe-test）——
  // 探针是管道心跳非真实问题，混在结果里会稀释真实事件（占展示位/干扰处置判断）。
  // includeProbe: true 时不过滤，供诊断探针落账本身（如验证探针是否在正常写入）。
  const includeProbe = (params.includeProbe as boolean) ?? false;
  if (!includeProbe) events = events.filter(e => !isHealingProbeEvent(e));
  return textResponse(JSON.stringify(events, null, 2));
}

/** 创建 healing event 管理工具 */
export function createManageHealingEventsTool(ctx: ToolContext, healingRepo: HealingEventRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ToolResponse> => {
    const action = params.action as string;
    if (action === 'query') return handleQuery(params, healingRepo);
    if (action === 'batch_resolve') return handleBatchResolve(params, healingRepo);
    if (action === 'batch_bind') return handleBatchBind(params, healingRepo);
    const ids = params.eventIds as string[];
    if (!ids?.length) return errorResponse("[错误] eventIds 不能为空");
    if (action === 'resolve' || action === 'dismiss') {
      const fn = action === 'resolve'
        ? (id: string) => healingRepo.resolve(id, { action: ((params.resolutionAction as string) ?? 'no_action') as HealingResolutionAction, decidedBy: 'agent' as const, decidedAt: new Date().toISOString(), notes: (params.resolutionNotes as string) ?? '' })
        : (id: string) => healingRepo.updateStatus(id, 'dismissed');
      const res = await Promise.allSettled(ids.map(fn));
      const succeeded = res.filter(r => r.status === 'fulfilled').length;
      if (succeeded < ids.length) {
        const failedReasons = res
          .map((r, i) => r.status === 'rejected' ? `${ids[i]}: ${(r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason)}` : null)
          .filter(Boolean)
          .join('; ');
        return errorResponse(`[错误] 部分失败：${succeeded}/${ids.length} 成功。失败原因：${failedReasons}`);
      }
      return textResponse(`完成: ${succeeded}/${ids.length} 成功`);
    }
    return errorResponse(`[错误] 未知操作: ${action}。支持的操作：query / resolve / dismiss / batch_resolve / batch_bind。`);
  };
  return {
    name: "manage_healing_events",
    description: "查询和管理 healing events（系统自愈问题记录）. When: 查看自愈检测到的问题 / 标记已解决或忽略 / 同族事件批量归口到 issue. Not for: 主动注入 healing 标记 → 走 speak 的 healing 块. Output: 问题列表或处置确认（action: query/resolve/dismiss/batch_resolve/batch_bind）. query 默认过滤健康探针心跳事件（includeProbe: true 可含，仅诊断用）. batch_resolve: 按 filter 批量处置（filterStatus/filterErrorType/filterRuleId/filterBoundIssue/filterCreatedBefore/filterCreatedAfter 替代 eventIds），单批上限 100，建议先 dryRun 预览再真实执行；响应含 truncated=true 时需再次执行处理剩余批次. ⚠️批量闸：未归口 high 事件禁批量静默——先 batch_bind 归口（high 的推荐路径）或逐条处置；已归口（bound）high 可随 issue 收尾批量 resolve（filterBoundIssue=N）. batch_bind：按 filter 批量归口到 GitHub issue（bind≠resolve，事件保持 open 直到修复合入后收尾）——issueNumber 必填且须为真实存在的 issue 编号（幻觉编号会使后续 filterBoundIssue 收尾静默终结 high，bind 前用 gh issue view 确认）+ 至少一个过滤条件（防异质归口），guard_intercept 事件族按 filterErrorType=guard_intercept + filterRuleId=<指纹> 分组归口；high 不设闸（归口是结构化认领非静默，恰是 high 的推荐去向）；只作用未归口 open 事件；单批 100，truncated=true 需再次执行. GOTCHA: resolve/dismiss 对不存在的 eventId 返回 isError 并列明失败 ID（fail-closed——假成功曾致回执与库状态不一致）；部分失败时同样返回 isError——需检查响应中失败计数.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["query", "resolve", "dismiss", "batch_resolve", "batch_bind"], description: "操作类型" },
        status: { type: "string", enum: ["open", "resolved", "dismissed"], description: "按状态筛选" },
        errorType: { type: "string", description: "按错误类型筛选" },
        includeProbe: { type: "boolean", description: "true 时包含健康探针事件（默认过滤）。仅诊断探针落账时开启" },
        eventIds: { type: "array", items: { type: "string" }, description: "event ID 列表" },
        resolutionAction: { type: "string", enum: ["prompt_updated", "memory_added", "tool_fixed", "config_changed", "no_action", "deferred"], description: "修复行动" },
        resolutionNotes: { type: "string", description: "解决方式说明" },
        filterStatus: { type: "string", enum: ["open", "resolved", "dismissed"], description: "[batch_resolve] 按状态筛选，默认 open" },
        filterErrorType: { type: "string", description: "[batch_resolve/batch_bind] 按错误类型筛选。guard_intercept 归口用 filterErrorType=guard_intercept" },
        filterRuleId: { type: "string", description: "[batch_resolve/batch_bind] 按 context.ruleId 筛选（guard_intercept 指纹分类器字段）——同 ruleId = 同根因事件族，归口/收尾按此分组" },
        filterSeverity: { type: "string", enum: ["low", "medium", "high"], description: "[batch_bind] 按 severity 筛选" },
        filterBoundIssue: { type: "number", description: "[batch_resolve] 按归口 issue 编号筛选——修复合入后 batch_resolve + filterBoundIssue=<N> 收尾该 issue 归口的事件族" },
        filterCreatedBefore: { type: "string", description: "[batch_resolve/batch_bind] ISO 时间戳，筛选 created_at < 此值的事件" },
        filterCreatedAfter: { type: "string", description: "[batch_resolve/batch_bind] ISO 时间戳，筛选 created_at > 此值的事件" },
        issueNumber: { type: "number", description: "[batch_bind] 必填。归口目标 GitHub issue 编号（正整数）" },
        dryRun: { type: "boolean", description: "[batch_resolve/batch_bind] true 时只返回匹配事件数，不执行" },
      },
      required: ["action"],
    },
    execute: exec,
  };
}
