/**
 * RHI 健康信号处置工具（F20260917trig §2）。
 *
 * 与獭间信号工具（signal-tools.ts）分开：那是 signal_events 台账（獭间协调），
 * 这是 signals 表（健康观测）——两个信号池语义不同（方案设计取舍③）。
 *
 * triage_signal：处置写入路径。日报獭处置完信号后必须调此工具留痕，
 * 对账公式 M+K+D=N 从 triage 数据自动生成（「从自觉变机制」）。
 * list_rhi_signals：未接单清单查询——处置者（日报獭/搭档/被派工小獭）的派工输入。
 *
 * 写入语义契约（方案 §2 幂等语义表——实现必须逐行对齐）：
 * - bind_issue：triage_status='triaged', issue_number=N, triaged_at=now（issueNumber 必填；覆盖式更新允许换绑）
 * - in_progress：triage_status='in_progress'（前置须已 bind_issue；幂等跳过）
 * - dismiss：status='dismissed' 终态 + triage_note 必写库（note 必填；幂等跳过）
 *
 * 架构约束（F3）：写路径只有 SignalRepository.triage() 一个，本工具不各自实现 SQL。
 */

import type { ToolContext, AgentTool } from "@usecases/ports/agent-tools";
import { textResponse, errorResponse } from "@usecases/ports/agent-tools";
import type { SignalRepository, SignalBatchBindFilter } from "@usecases/health/signal-repository";

/** 参数校验：signalId/action 合法性检查（拆出控 complexity）。batch_bind 是批量路径，
 *  不需要 signalId，由 handleBatchBind 单独校验（#1052） */
function validateTriageParams(params: Record<string, unknown>): { signalId: number; action: "bind_issue" | "in_progress" | "dismiss" } | { error: string } {
  const signalId = params.signalId as number | undefined;
  const action = params.action as string | undefined;
  if (signalId === undefined || !Number.isInteger(signalId)) {
    return { error: "[错误] signalId 必填（整数）——用 list_rhi_signals 拉清单拿 ID。" };
  }
  if (action !== 'bind_issue' && action !== 'in_progress' && action !== 'dismiss') {
    return { error: "[错误] action 必须是 bind_issue / in_progress / dismiss 之一（批量归口用 batch_bind）。" };
  }
  return { signalId, action };
}

/** #1052：batch_bind——未接单信号按 filter 批量归口（照 manage_healing_events.batch_resolve 模式）。
 *  根治「daily-review 150 条逐条 triage_signal 被『连续同构调用』循环守卫阻断」的流程冲突——
 *  >10 条同类型同归口时走批量，逐条仅用于异质处置。 */
function handleBatchBind(params: Record<string, unknown>, signalRepo: SignalRepository): ReturnType<typeof textResponse> {
  const issueNumber = params.issueNumber as number | undefined;
  if (!Number.isInteger(issueNumber) || (issueNumber as number) <= 0) {
    return errorResponse("[错误] batch_bind 的 issueNumber 必填（正整数）——批量归口的目标 issue。");
  }
  const filter: SignalBatchBindFilter = {};
  if (params.filterSignalType) filter.signalType = String(params.filterSignalType);
  if (params.filterSeverity) filter.severity = String(params.filterSeverity);
  // Why: 至少一个过滤条件——「全部未接单绑到同一 issue」属异质归口（不同类型指向不同根因），
  // 应逐条判断；无 filter 的全量绑定等于把判断外包给一次调用，拦在入口
  if (!filter.signalType && !filter.severity) {
    return errorResponse("[错误] batch_bind 至少需要一个过滤条件（filterSignalType / filterSeverity）——全部未接单绑同一 issue 属异质归口，应逐条或分组归口。");
  }
  const note = (params.note as string | undefined)?.trim() || '';
  const dryRun = (params.dryRun as boolean) ?? false;

  const result = signalRepo.batchBindIssue(filter, issueNumber as number, {
    note: note || undefined,
    dryRun,
  });
  if (dryRun) {
    return textResponse(JSON.stringify({ dryRun: true, matched: result.matched }, null, 2));
  }
  return textResponse(JSON.stringify({
    matched: result.matched,
    bound: result.bound,
    boundIds: result.boundIds,
    issueNumber,
    truncated: result.truncated,
    totalMatched: result.totalMatched,
  }, null, 2));
}

/** triage_signal：RHI 信号处置留痕（bind_issue / in_progress / dismiss 三动作 + batch_bind 批量归口） */
export function createTriageSignalTool(ctx: ToolContext, signalRepo: SignalRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof textResponse>> => {
    // #1052：批量路径先分流（无 signalId），单条路径走原校验
    if (params.action === 'batch_bind') return handleBatchBind(params, signalRepo);
    const valid = validateTriageParams(params);
    if ('error' in valid) return errorResponse(valid.error);
    const issueNumber = params.issueNumber as number | undefined;
    const note = (params.note as string | undefined)?.trim() || '';

    const result = signalRepo.triage(valid.signalId, valid.action, { issueNumber, note: note || undefined });
    if (!result.ok) {
      return errorResponse(`[错误] ${result.reason}`);
    }
    const r = result.record!;
    const triageState = r.triage_status ?? '未接单';
    return textResponse(
      `[triage 完成] 信号 #${r.id}（${r.signal_type} · ${r.severity}）\n` +
      `  处置状态：${triageState}` +
      (r.issue_number ? ` · 绑定 issue #${r.issue_number}` : '') + '\n' +
      (r.triage_note ? `  处置说明：${r.triage_note}` : '') + '\n' +
      `  终态：${r.status}` +
      (result.reason ? `\n  备注：${result.reason}` : ''),
    );
  };
  return {
    name: "triage_signal",
    description: "处置一条 RHI 健康信号（留痕写库）. When: 日报处置段处置完 critical 信号后必须调用留痕（对账公式 M+K+D=N 的数据源）/ 面板一键操作的后端写路径. Not for: 獭间信号 signal_events（那是 query_signals/resolve_signal 的范围）/ 改检测口径（走特性流程）. Output: 处置确认（状态 + issue 绑定 + note）. 语义: bind_issue=归口到 issue（issueNumber 必填，覆盖式允许换绑）；in_progress=标修复中（前置须已 bind_issue，幂等跳过）；dismiss=终态化（note 必填必写库——「不处置必须是判断结论不能是沉默」）；batch_bind=按 filter 批量归口未接单信号（issueNumber 必填 + filterSignalType/filterSeverity 至少一个，单批上限 100，truncated=true 需再次执行，建议先 dryRun 预览——同类型 >10 条同归口时用它防循环守卫拦截）. GOTCHA: ①dismiss 的 note 为空会被拒绝；②in_progress 未先 bind_issue 会被拒绝；③对已终态信号重复调用返回幂等结果无副作用；④batch_bind 只作用于未接单（open 且 triage_status 为空），已归口/修复中的不参与（换绑走单条 bind_issue）.",
    parameters: {
      type: "object",
      properties: {
        signalId: { type: "number", description: "信号 ID（list_rhi_signals 返回的整数 id；batch_bind 不需要）" },
        action: { type: "string", enum: ["bind_issue", "in_progress", "dismiss", "batch_bind"], description: "处置动作" },
        issueNumber: { type: "number", description: "GitHub issue 编号（bind_issue / batch_bind 必填）" },
        note: { type: "string", description: "处置说明（dismiss 必填；bind_issue / batch_bind 可选）" },
        filterSignalType: { type: "string", description: "[batch_bind] 按信号类型过滤（signal_type 精确匹配）" },
        filterSeverity: { type: "string", enum: ["critical", "warning"], description: "[batch_bind] 按严重度过滤" },
        dryRun: { type: "boolean", description: "[batch_bind] true 时只返回匹配数，不执行绑定" },
      },
      // Why: signalId 不进 required——batch_bind 批量路径无 signalId（#1052）；
      // 单条动作的 signalId 缺失由 validateTriageParams 报错引导（healing 工具同模式）
      required: ["action"],
    },
    execute: exec,
  };
}

/** list_rhi_signals：RHI 信号清单查询（status / severity / triageStatus 三维过滤） */
export function createListRhiSignalsTool(_ctx: ToolContext, signalRepo: SignalRepository): AgentTool {
  const exec = async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof textResponse>> => {
    const status = (params.status as string | undefined) ?? 'open';
    const severity = params.severity as string | undefined;
    const triageStatus = params.triageStatus as string | undefined;

    let rows;
    if (triageStatus !== undefined) {
      rows = signalRepo.findByTriageStatus(triageStatus, status);
    } else if (status === 'all') {
      rows = [
        ...signalRepo.findOpen(),
        ...signalRepo.findByStatus('resolved'),
        ...signalRepo.findByStatus('dismissed'),
      ];
    } else {
      rows = signalRepo.findByStatus(status);
    }
    if (severity) rows = rows.filter(s => s.severity === severity);

    if (rows.length === 0) return textResponse("（无匹配 RHI 信号）");
    const lines = rows.map(s =>
      `[#${s.id}] ${s.signal_type} · ${s.severity} · ${s.status}` +
      (s.status !== 'open' ? '' : s.triage_status ? ` · ${s.triage_status}` + (s.issue_number ? `→#${s.issue_number}` : '') : ' · 未接单') + '\n' +
      `  ${s.file_path ?? s.feature_id ?? ''} · first_seen ${s.first_seen.slice(0, 10)} · occurrences ${s.occurrences}` +
      (s.triage_note ? `\n  note: ${s.triage_note}` : ''),
    );
    return textResponse(`RHI 信号（${rows.length} 条）：\n${lines.join('\n')}`);
  };
  return {
    name: "list_rhi_signals",
    description: "查询 RHI 健康信号清单（signals 表）. When: 日报处置段拉 critical 清单 / 未接单清单查询作为派工输入 / 面板后端. Not for: 獭间信号（query_signals）. Output: 信号列表（id/类型/severity/处置状态/issue 绑定/note）. GOTCHA: triageStatus 传 'null' 或省略该参数且想看未接单时用 triageStatus='null'——表示 triage_status IS NULL 的未接单信号.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "resolved", "dismissed", "all"], description: "终态过滤（默认 open）" },
        severity: { type: "string", enum: ["critical", "warning"], description: "按严重度过滤（可选）" },
        triageStatus: { type: "string", description: "按处置状态过滤：'null'=未接单 / 'triaged'=已归口 / 'in_progress'=修复中（可选）" },
      },
    },
    execute: exec,
  };
}
