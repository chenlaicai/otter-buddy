/**
 * F20261010gshw：写落点求值器影子接线（观察模式）——记录器。
 *
 * 背景：write-target-evaluator（Phase 1 #1381 + Phase 2 #1411）已过 141 例语料
 * shadow 三跑判据，但那是「题库考」；搭档拍板打开「真实考场」观察（2026-10-10
 * 「影子做好了当然要打开观察，否则不等于白做吗」）——每条真实 bash 命令经
 * 判定链时，求值器并行求值一遍，**只记录不干预**：旧链判定照常生效并返回，
 * 影子结果落 healing_events 台账供观察期聚合。
 *
 * 设计铁律（大獭任务书 + 方案 v2 预注册）：
 * - **零干预**：本模块不返回任何拦截意见，不 throw——任何内部错误吞掉记日志，
 *   影子是旁听不是陪审。写入失败仅 logger.warn，绝不影响判定链返回值。
 * - **旁路防抖**：同一命令短窗内只记一次（连续重试同命令不刷屏——#1353 连环
 *   拦截的台账放大先例，shadow 侧同型治理）。
 * - **口径对齐 #1360/#1411**：结构化 context（shadow 维度专用 errorType +
 *   oldVerdict/evaluatorWouldAllow/targetPaths/unevalReason/oldRuleId/
 *   commandHead/hasWorktreePath），replay/固化脚本可直接 SQL 消费。
 * - **只记「有信息量」的形态（双向）**：真误拦候选（旧链拦+求值器会放）与
 *   EVAL_GAIN（旧链放+求值器会拦）；双方同判/回落不落账防台账膨胀。
 *
 * 判定链挂点：circuit-breaker-helpers abortOnUnsafeBash（唯一看到全部 bash
 * 命令 + 旧链裁决的位置）。求值器是纯函数，无 IO，性能开销为一次词法解析
 * （实测语料 141 例全量 <100ms 量级，单条微秒级）。
 */
import { evaluateWriteTargets, pathWithinMain } from "./write-target-evaluator";
import { classifyGuardInterceptReason } from "./guard-intercept-classify";
import { sanitizeQuotedText } from "./quoted-text-sanitizer";
import type { LogContext } from "@usecases/ports/logger";

/** 影子事件 errorType（SQL 聚合维度；healing_events.error_type 无 CHECK 约束可扩展） */
export const SHADOW_EVAL_ERROR_TYPE = "guard_eval_shadow";

/** 旁路防抖窗（毫秒）——同 otter 同命令在该窗内不重复落账 */
const SHADOW_DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** 防抖缓存：otterId -> (commandHash -> lastSeenMs)。无界增长风险：otter 数 ×
 *  独立命令数，量级远小于台账本身；观察期结束随模块卸载，不做 LRU。 */
const recentShadowRecords = new Map<string, Map<string, number>>();

/** healing repo 最小接口（结构对齐 HealingEventRepository.create 的必填字段子集） */
export interface ShadowHealingSink {
  create(event: {
    id: string;
    messageId: string;
    conversationId: string;
    otterId: string;
    errorType: string;
    severity: string;
    description: string;
    suggestion: string;
    context: Record<string, unknown>;
    status: string;
    resolution: null;
    createdAt: string;
    resolvedAt: null;
  }): Promise<unknown>;
}

/** 影子求值结果（evaluateWriteTargets 的判据可观测投影） */
export interface ShadowEvalOutcome {
  /** evaluated 且无主仓落点 = 求值器会放行（观察期核心信号） */
  evaluatorWouldAllow: boolean;
  /** 求值器判主仓写（拦截意见） */
  evaluatorWouldBlock: boolean;
  /** 落点摘要（≤3 条，供人工裁决定位） */
  targetPaths: string[];
  unevalReason: string | null;
}

/** 影子求值（纯函数，可单测）：evaluateWriteTargets 的三态投影。 */
export function shadowEvaluate(command: string, projectRoot: string): ShadowEvalOutcome {
  const r = evaluateWriteTargets(command, projectRoot);
  if (r.kind === "unevaluated") {
    return { evaluatorWouldAllow: false, evaluatorWouldBlock: false, targetPaths: [], unevalReason: r.reason };
  }
  const mainHits = r.targets.filter(t => pathWithinMain(t.path, projectRoot));
  // 求值器拦截口径：pathWithinMain（单一真相源——含 worktree 区 root 级排除与
  // 嵌套 decoy 防线，PR #1381 §3.3）；记录器不另造判断，口径漂移即审视红线
  const wouldBlock = mainHits.length > 0;
  return {
    evaluatorWouldAllow: !wouldBlock,
    evaluatorWouldBlock: wouldBlock,
    targetPaths: mainHits.slice(0, 3).map(t => t.path),
    unevalReason: null,
  };
}

/** 防抖判定（纯函数，可单测）：true = 该记录应跳过（窗内已记）。 */
export function shadowShouldSkip(otterId: string, command: string, now: number): boolean {
  const perOtter = recentShadowRecords.get(otterId);
  if (!perOtter) return false;
  const last = perOtter.get(command);
  if (last === undefined) return false;
  return now - last < SHADOW_DEDUP_WINDOW_MS;
}

/** 落账 context 组装（纯函数，可单测——对齐 buildGuardInterceptContext 的字段纪律）。 */
export function buildShadowEvalContext(
  outcome: ShadowEvalOutcome,
  command: string,
  oldBlock: string | null,
): Record<string, unknown> {
  // 旧链拦截时分类 ruleId；放行时无 reason 可分类，oldRuleId 记 none
  const rule = oldBlock !== null ? classifyGuardInterceptReason(oldBlock) : null;
  return {
    layer: "framework",
    kind: "shadow_eval", // 与拦截事件（kind 无此字段）区分：shadow 是对照记录非拦截
    oldVerdict: oldBlock !== null ? "BLOCK" : "ALLOW",
    evaluatorWouldAllow: outcome.evaluatorWouldAllow,
    evaluatorWouldBlock: outcome.evaluatorWouldBlock,
    targetPaths: outcome.targetPaths,
    unevalReason: outcome.unevalReason,
    oldRuleId: rule?.ruleId ?? "none",
    oldRuleLayer: rule?.layer ?? "none",
    commandHead: sanitizeQuotedText(command).substring(0, 120),
    hasWorktreePath: command.includes("/worktrees/"),
  };
}

/** 防抖登记（在过滤后，未落账形态不占防抖预算） */
function registerDedup(otterId: string, command: string, now: number): void {
  let perOtter = recentShadowRecords.get(otterId);
  if (!perOtter) {
    perOtter = new Map();
    recentShadowRecords.set(otterId, perOtter);
  }
  perOtter.set(command, now);
}

/** 组装并发射 healing 事件（fire-and-forget；错费只在 sink.create 侧） */
function emitShadowEvent(params: {
  command: string;
  oldBlock: string | null;
  otterId: string;
  ids: { messageId?: string; conversationId?: string };
  sink: ShadowHealingSink;
  logger?: { warn: (msg: string, context?: LogContext) => void };
  now: number;
  outcome: ShadowEvalOutcome;
  isMissBlockCandidate: boolean;
}): void {
  const { command, oldBlock, otterId, ids, sink, logger, now, outcome, isMissBlockCandidate } = params;
  const context = buildShadowEvalContext(outcome, command, oldBlock);
  const desc = isMissBlockCandidate
    ? `shadow_eval 真误拦候选：旧链拦截（${String(context.oldRuleId)}）但求值器会放行：${sanitizeQuotedText(command).substring(0, 100)}`
    : `shadow_eval EVAL_GAIN：旧链放行但求值器判主仓写（${outcome.targetPaths[0] ?? ""}）：${sanitizeQuotedText(command).substring(0, 80)}`;
  sink.create({
    id: crypto.randomUUID(),
    messageId: ids.messageId ?? "",
    conversationId: ids.conversationId ?? "",
    otterId,
    errorType: SHADOW_EVAL_ERROR_TYPE,
    severity: "low",
    description: desc,
    suggestion: isMissBlockCandidate
      ? "观察期核心信号（只记录不干预）——人工裁决该命令应放行还是拦截；真误放>0 则停止切换（判据见 F20261010gshw）"
      : "EVAL_GAIN 记录不告警（观察期）——旧链漏拦面的实战发现，切换 PR 的收益量化输入",
    context,
    status: "open",
    resolution: null,
    createdAt: new Date(now).toISOString(),
    resolvedAt: null,
  }).catch(err => {
    // 零干预铁律：写入失败仅日志，不阻断拦截本身（对齐 guard intercept hook 的 fire-and-forget 纪律）
    logger?.warn("[shadow-eval] healing write failed (non-fatal)", { err: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * 影子记录主入口（fire-and-forget，调用点在 abortOnUnsafeBash 内——旧链判定
 * 出结果后无论拦否都调用，影子绝不影响返回值）。
 *
 * 双向信息量过滤（判据预注册见特性文档「观察期判据」节）：
 * - 真误拦候选（核心）：oldBlock ≠ null（旧链拦）+ 求值器 evaluated 会放行 →
 *   逐条人工裁决，真误放（人工裁 BLOCK）>0 → 停止切换回炉
 * - EVAL_GAIN（记录不告警）：oldBlock = null（旧链放）+ 求值器 evaluated 会拦
 *   ——旧链漏拦面（cd worktree 后写主仓灰区族，终局报告实测 10 例）的实战发现
 * 其余形态（双方同判 / 求值器 unevaluated 回落）无对照信息量，不落账防台账膨胀。
 */
export function recordShadowEval(params: {
  command: string;
  /** 旧链拦截文案；null = 旧链放行 */
  oldBlock: string | null;
  otterId: string;
  ids: { messageId?: string; conversationId?: string };
  projectRoot: string;
  sink: ShadowHealingSink | undefined;
  logger?: { warn: (msg: string, context?: LogContext) => void };
  now?: number;
}): void {
  const { command, oldBlock, otterId, ids, projectRoot, sink, logger } = params;
  if (!sink) return;
  const now = params.now ?? Date.now();
  let outcome: ShadowEvalOutcome;
  try {
    outcome = shadowEvaluate(command, projectRoot);
  } catch (err) {
    // 零干预铁律：求值器异常不外溢——吞掉记日志，无落账（fail-safe）
    logger?.warn("[shadow-eval] evaluator threw (swallowed, no record)", { err: err instanceof Error ? err.message : String(err) });
    return;
  }
  // 双向信息量过滤
  const isMissBlockCandidate = oldBlock !== null && outcome.evaluatorWouldAllow;
  const isEvalGain = oldBlock === null && outcome.evaluatorWouldBlock;
  if (!isMissBlockCandidate && !isEvalGain) return;
  if (shadowShouldSkip(otterId, command, now)) return;
  registerDedup(otterId, command, now);
  emitShadowEvent({ command, oldBlock, otterId, ids, sink, logger, now, outcome, isMissBlockCandidate });
}
