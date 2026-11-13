/**
 * Healing 相关工具：speak healing 参数校验/落账和 healing event 管理。
 */

import type { HealingEventRepository, HealingEventBatchFilter } from "@usecases/healing/healing-event-repository";
import type { HealingResolutionAction, HealingEventStatus, HealingErrorType, HealingSeverity } from "@entities/healing/healing-event";
import { healingAlertRegistry } from "@usecases/healing/healing-alert-registry";
import { isHealingProbeEvent } from "@usecases/healing/constants";
import type { Logger } from "@usecases/ports/logger";
import type { ToolContext, AgentTool, ToolResponse } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";
import { checkOpenIssue, type CheckIssueBinding } from "../../github/issue-binding";

/** 模型自报 healing 的合法 type 集合（走 speak healing 参数，非框架层自动写库类型） */
const SELF_REPORT_TYPES: ReadonlySet<string> = new Set([
  'tool_failure', 'missing_context', 'wrong_tool', 'format_violation',
  'knowledge_gap', 'performance', 'other', 'tool_use_feedback', 'runtime_status_mismatch',
]);

const SELF_REPORT_SEVERITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const MAX_FIELD_LENGTH = 500;
const MAX_ISSUES_PER_SPEAK = 10;

/** speak healing 参数的 JSON Schema（F20261113hlprm）：白名单与 parseHealingParam 同源维护 */
export const SPEAK_HEALING_PARAM_SCHEMA = {
  type: "array",
  description: "系统自愈上报（可选）。遇系统问题（工具故障/检索缺失/格式异常/工具难用等）时填，每条一个 issue；没遇到问题就不传。",
  items: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: [...SELF_REPORT_TYPES],
        description: "问题类型。工具难用/参数反直觉/多余报 tool_use_feedback（description 以 [tool:工具名] 开头）。",
      },
      severity: { type: "string", enum: [...SELF_REPORT_SEVERITIES], description: "严重度，缺省 low。" },
      description: { type: "string", description: "一句话描述问题（必填）。" },
      suggestion: { type: "string", description: "建议的处置（可选）。" },
    },
    required: ["type", "description"],
  },
} as const;

/** speak healing 参数解析后的一条 issue（已校验合法） */
export interface HealingIssueParam {
  type: HealingErrorType;
  severity: HealingSeverity;
  description: string;
  suggestion: string;
}

export interface HealingParamResult {
  issues: HealingIssueParam[];
  error: string | null;
}

/** 单条 severity 合法化（缺省 low；非法返回 error） */
function normalizeSeverity(raw: unknown, index: number): { value: HealingSeverity; error: null } | { value: null; error: string } {
  if (raw === undefined || raw === null) return { value: 'low', error: null };
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (!v) return { value: 'low', error: null };
    if (SELF_REPORT_SEVERITIES.has(v)) return { value: v as HealingSeverity, error: null };
  }
  return { value: null, error: `healing 参数第 ${index + 1} 条 severity 非法，可选 low / medium / high。` };
}

/** 单条 issue 合法化（非法返回可操作 error） */
function normalizeIssueItem(item: unknown, index: number): { issue: HealingIssueParam } | { error: string } {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return { error: `healing 参数第 ${index + 1} 条必须是对象（含 type/description 字段）。` };
  }
  const obj = item as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type.trim().toLowerCase() : '';
  if (!type) {
    return { error: `healing 参数第 ${index + 1} 条缺 type 字段（必填）。可选：${[...SELF_REPORT_TYPES].join(' / ')}。` };
  }
  if (!SELF_REPORT_TYPES.has(type)) {
    return { error: `healing 参数第 ${index + 1} 条 type "${type}" 不在白名单。可选：${[...SELF_REPORT_TYPES].join(' / ')}。` };
  }
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  if (!description) {
    return { error: `healing 参数第 ${index + 1} 条缺 description 字段（必填，一句话描述问题）。` };
  }
  const severity = normalizeSeverity(obj.severity, index);
  if (severity.error) return { error: severity.error };
  return {
    issue: {
      type: type as HealingErrorType,
      severity: severity.value as HealingSeverity,
      description: description.slice(0, MAX_FIELD_LENGTH),
      suggestion: typeof obj.suggestion === 'string' ? obj.suggestion.trim().slice(0, MAX_FIELD_LENGTH) : '',
    },
  };
}

/**
 * 校验 speak 的 healing 结构化参数（F20261113hlprm：healing 从 body 文本标签改为独立参数）。
 * 未传/空 → 空 issues；非法 → 可操作 error（原子阻断发言，不落账不建 entry）。
 */
export function parseHealingParam(raw: unknown): HealingParamResult {
  if (raw === undefined || raw === null) return { issues: [], error: null };
  if (!Array.isArray(raw)) {
    return { issues: [], error: 'healing 参数必须是 issue 数组（如 [{"type":"tool_use_feedback","description":"..."}]）；没遇到问题就不传该参数。' };
  }
  if (raw.length === 0) return { issues: [], error: null };
  if (raw.length > MAX_ISSUES_PER_SPEAK) {
    return { issues: [], error: `healing 参数最多 ${MAX_ISSUES_PER_SPEAK} 条（收到 ${raw.length} 条），请精简。` };
  }
  const issues: HealingIssueParam[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const normalized = normalizeIssueItem(raw[i], i);
    if ('error' in normalized) return { issues: [], error: normalized.error };
    issues.push(normalized.issue);
  }
  return { issues, error: null };
}

/**
 * 落账 healing issues（F20261113hlprm：从 interceptHealingReport 迁移，参数法专用）。
 * high → healingAlertRegistry.enqueue + repo.create；fire-and-forget 双写各自失败不阻塞对方
 * （审计面以 healing_events 为准，语义同 F20260826mwrd C3）。
 */
export function persistHealingIssues(issues: HealingIssueParam[], ctx: ToolContext, repo: HealingEventRepository, logger?: Logger): void {
  if (issues.length === 0) return;
  const now = new Date().toISOString();
  const meta = { otterId: ctx.otterId, conversationId: ctx.conversationId, messageId: ctx.currentMessageId };
  for (const issue of issues) {
    if (issue.severity === 'high') {
      logger?.warn('High severity healing event', { type: issue.type, description: issue.description });
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
  checkIssueBinding: CheckIssueBinding,
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

  return executeHealingBatchBind(filter, issueNumber, dryRun, healingRepo, checkIssueBinding);
}

async function executeHealingBatchBind(
  filter: HealingEventBatchFilter,
  issueNumber: number,
  dryRun: boolean,
  healingRepo: HealingEventRepository,
  checkIssueBinding: CheckIssueBinding,
): Promise<ToolResponse> {
  if (dryRun) {
    const result = await healingRepo.batchBindIssue(filter, issueNumber, { dryRun: true });
    return textResponse(JSON.stringify({ dryRun: true, matched: result.matched, issueNumber }, null, 2));
  }

  // 外部状态查不清就 fail-closed；dryRun 上方已返回，只读本地预览不调用 gh。
  const issueCheck = await checkIssueBinding(issueNumber);
  if (!issueCheck.ok) return errorResponse(`[错误] ${issueCheck.reason}`);

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
export function createManageHealingEventsTool(
  ctx: ToolContext,
  healingRepo: HealingEventRepository,
  checkIssueBinding: CheckIssueBinding = checkOpenIssue,
): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ToolResponse> => {
    const action = params.action as string;
    if (action === 'query') return handleQuery(params, healingRepo);
    if (action === 'batch_resolve') return handleBatchResolve(params, healingRepo);
    if (action === 'batch_bind') return handleBatchBind(params, healingRepo, checkIssueBinding);
    const ids = params.eventIds as string[];
    if (!ids?.length) return errorResponse("[错误] eventIds 不能为空");
    if (action === 'resolve' || action === 'dismiss') {
      // #1545 缺陷③：dismiss 与 resolve 同构落 resolution——此前 dismiss 走 updateStatus
      // 丢弃 resolutionNotes，终态记录只剩 status+resolved_at（「为何 dismiss」不可考）
      const fn = action === 'resolve'
        ? (id: string) => healingRepo.resolve(id, { action: ((params.resolutionAction as string) ?? 'no_action') as HealingResolutionAction, decidedBy: 'agent' as const, decidedAt: new Date().toISOString(), notes: (params.resolutionNotes as string) ?? '' })
        : (id: string) => healingRepo.dismiss(id, { action: ((params.resolutionAction as string) ?? 'no_action') as HealingResolutionAction, decidedBy: 'agent' as const, decidedAt: new Date().toISOString(), notes: (params.resolutionNotes as string) ?? '' });
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
    description: "查询和管理 healing events（系统自愈问题记录）. When: 查看自愈检测到的问题 / 标记已解决或忽略 / 同族事件批量归口到 issue. Not for: 主动注入 healing 标记 → 走 speak 的 healing 参数（结构化字段，勿在 body 文本里写标签）. Output: 问题列表或处置确认（action: query/resolve/dismiss/batch_resolve/batch_bind）. query 默认过滤健康探针心跳事件（includeProbe: true 可含，仅诊断用）. batch_resolve: 按 filter 批量处置（filterStatus/filterErrorType/filterRuleId/filterBoundIssue/filterCreatedBefore/filterCreatedAfter 替代 eventIds），单批上限 100，建议先 dryRun 预览再真实执行；响应含 truncated=true 时需再次执行处理剩余批次. ⚠️批量闸：未归口 high 事件禁批量静默——先 batch_bind 归口（high 的推荐路径）或逐条处置；已归口（bound）high 可随 issue 收尾批量 resolve（filterBoundIssue=N）. batch_bind：按 filter 批量归口到 GitHub issue（bind≠resolve，事件保持 open 直到修复合入后收尾）——issueNumber 必填且必须为 OPEN（CLOSED/不存在/状态查询失败均拒绝且不写库；幻觉编号会使后续 filterBoundIssue 收尾静默终结 high）+ 至少一个过滤条件（防异质归口），guard_intercept 事件族按 filterErrorType=guard_intercept + filterRuleId=<指纹> 分组归口；high 不设闸（归口是结构化认领非静默，恰是 high 的推荐去向）；只作用未归口 open 事件；单批 100，truncated=true 需再次执行. GOTCHA: resolve/dismiss 对不存在或已终态（非 open）的 eventId 返回 isError 并列明失败 ID（fail-closed——假成功曾致回执与库状态不一致；dismiss 仅作用 open 态——已终态的再 dismiss 同样报错，防重复处置静默吞）；部分失败时同样返回 isError——需检查响应中失败计数.",
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
        issueNumber: { type: "number", description: "[batch_bind] 必填。归口目标 GitHub OPEN issue 编号（其他状态或查询失败拒绝）" },
        dryRun: { type: "boolean", description: "[batch_resolve/batch_bind] true 时只返回匹配事件数，不执行" },
      },
      required: ["action"],
    },
    execute: exec,
  };
}
