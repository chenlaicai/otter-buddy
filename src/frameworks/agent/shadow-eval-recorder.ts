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
 * - **旁路防抖**：同一命令短窗内只记一次个体记录（连续重试同命令不刷屏——
 *   #1353 连环拦截的台账放大先例，shadow 侧同型治理）。聚合计数不受防抖影响。
 * - **口径对齐 #1360/#1411**：结构化 context（shadow 维度专用 errorType +
 *   oldVerdict/subkind/evaluatorWouldAllow/targetPaths/unevalReason/oldRuleId/
 *   commandHead/hasWorktreePath），replay/固化脚本可直接 SQL 消费。
 *
 * 落账设计（审视 r1 处置后，PR #1420 review-1420-report S1/S2）：
 * - **个体记录（人工裁决面，防抖后）**：旧链 **main_write 维度**拦截全量落账
 *   三态（miss_block_candidate 真误拦候选 / same_block 同判拦 / family_fallback
 *   族内回落——族内成功率判据的逐条证据）+ EVAL_GAIN（旧链放+求值器会拦）。
 *   **维度过滤（S1）**：旧链因 sleep/kill/data_destructive 等**别族维度**拦截的
 *   命令不落个体——求值器只判写落点（main_write 维度），别族拦截+wouldAllow 是
 *   维度外样本而非误拦候选，混入会假触发「真误放>0 停止切换」红线（sleep 15 被
 *   正确拦截却在候选池里等裁决的假信号链）。
 * - **聚合记录（判据③④数据源，S2）**：进程内计数器（total/evaluated/
 *   unevaluated/mainWriteBlock×2/维度外/未识别指纹）按窗（60min 或 500 条）落
 *   单条 kind=shadow_eval_aggregate 记录——全量回落率/族内成功率可算，无需逐条
 *   落账防膨胀。计数为 pre-dedup 原始流量口径（与个体记录的防抖后口径分离，
 *   报告脚本按各自口径取数）。
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

/** 旧链写落点维度 ruleId（S1 维度过滤——求值器判定域与 shadow 语料口径一致，
 *  #1411 §3.2「main_write 完整命令子集」）。data_destructive/sleep/self_kill 等
 *  别族拦截是维度外样本，不进个体候选池。 */
const MAIN_WRITE_RULE_ID = "main_write";

/** 旁路防抖窗（毫秒）——同 otter 同命令在该窗内不重复落个体记录 */
const SHADOW_DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** 聚合刷新窗（毫秒）——计时器不可用（守卫路径禁副作用定时器），逐调用检查 */
const SHADOW_AGGREGATE_FLUSH_MS = 60 * 60 * 1000;
/** 聚合刷新条数阈值（先到先刷） */
const SHADOW_AGGREGATE_FLUSH_THRESHOLD = 500;

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

/** 个体记录子类（S1/S2 处置后三态+增益——报告脚本按此分桶） */
export type ShadowIndividualSubkind =
  | "miss_block_candidate" // 旧链 main_write 拦 + 求值器会放——人工裁决核心队列
  | "same_block" // 旧链 main_write 拦 + 求值器同判拦——族内成功率分子
  | "family_fallback" // 旧链 main_write 拦 + 求值器回落——族内成功率分母（fail-closed 面）
  | "eval_gain"; // 旧链放 + 求值器会拦——旧链漏拦面实战发现

/** 聚合计数器（S2——判据③④数据源；pre-dedup 原始流量口径） */
export interface ShadowAggregateCounters {
  total: number;
  evaluated: number;
  unevaluated: number;
  /** 旧链 main_write 拦 + 求值器 evaluated（miss_block_candidate + same_block 两态合计） */
  mainWriteBlockEvaluated: number;
  /** 旧链 main_write 拦 + 求值器 unevaluated（family_fallback） */
  mainWriteBlockFallback: number;
  /** 落个体记录数（防抖后——与 total 的差即防抖抑制量） */
  individualsLogged: number;
  /** 旧链别族维度拦截（求值器维度外——sleep/kill/data_destructive 等，不进判据） */
  dimensionMismatchBlocked: number;
  /** 指纹未识别的拦截文案（unknown——指纹表可能过期，可观测倒逼补表） */
  unknownBlocked: number;
  windowStart: number;
}

const emptyCounters = (windowStart: number): ShadowAggregateCounters => ({
  total: 0, evaluated: 0, unevaluated: 0,
  mainWriteBlockEvaluated: 0, mainWriteBlockFallback: 0,
  individualsLogged: 0, dimensionMismatchBlocked: 0, unknownBlocked: 0,
  windowStart,
});

/** 聚合状态（模块级；进程重启丢尾巴窗口——观察期统计可接受的近似） */
let aggregate = emptyCounters(0);
let lastAggregateFlush = 0;

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
  subkind: ShadowIndividualSubkind,
): Record<string, unknown> {
  // 旧链拦截时分类 ruleId；放行时无 reason 可分类，oldRuleId 记 none
  const rule = oldBlock !== null ? classifyGuardInterceptReason(oldBlock) : null;
  return {
    layer: "framework",
    kind: "shadow_eval", // 与拦截事件（kind 无此字段）区分：shadow 是对照记录非拦截
    subkind, // S1/S2 处置：个体三态+增益（报告脚本分桶键）
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

/** 组装并发射个体 healing 事件（fire-and-forget；错误只在 sink.create 侧吞） */
function emitIndividualEvent(params: {
  command: string;
  oldBlock: string | null;
  otterId: string;
  ids: { messageId?: string; conversationId?: string };
  sink: ShadowHealingSink;
  logger?: { warn: (msg: string, context?: LogContext) => void };
  now: number;
  outcome: ShadowEvalOutcome;
  subkind: ShadowIndividualSubkind;
}): void {
  const { command, oldBlock, otterId, ids, sink, logger, now, outcome, subkind } = params;
  const context = buildShadowEvalContext(outcome, command, oldBlock, subkind);
  const desc = subkind === "miss_block_candidate"
    ? `shadow_eval 真误拦候选：旧链 main_write 拦截但求值器会放行：${sanitizeQuotedText(command).substring(0, 100)}`
    : subkind === "eval_gain"
      ? `shadow_eval EVAL_GAIN：旧链放行但求值器判主仓写（${outcome.targetPaths[0] ?? ""}）：${sanitizeQuotedText(command).substring(0, 80)}`
      : subkind === "same_block"
        ? `shadow_eval 同判拦：旧链 main_write 拦+求值器同判主仓写：${sanitizeQuotedText(command).substring(0, 90)}`
        : `shadow_eval 族内回落：旧链 main_write 拦+求值器 unevaluated（${String(outcome.unevalReason)}）：${sanitizeQuotedText(command).substring(0, 80)}`;
  const suggestion = subkind === "miss_block_candidate"
    ? "观察期核心信号（只记录不干预）——人工裁决该命令应放行还是拦截：确认误拦（旧链错拦）/真误放（求值器错放，>0 触发停止切换判据红线）"
    : subkind === "eval_gain"
      ? "EVAL_GAIN 记录不告警（观察期）——旧链漏拦面的实战发现，切换 PR 的收益量化输入"
      : "同判/回落记录（无需裁决）——族内成功率判据的逐条证据，聚合口径见 F20261010gshw";
  sink.create({
    id: crypto.randomUUID(),
    messageId: ids.messageId ?? "",
    conversationId: ids.conversationId ?? "",
    otterId,
    errorType: SHADOW_EVAL_ERROR_TYPE,
    severity: "low",
    description: desc,
    suggestion,
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

/** 发射聚合记录（S2——判据③④数据源；单条记录携带窗口内全部计数） */
function emitAggregateEvent(params: {
  otterId: string;
  ids: { messageId?: string; conversationId?: string };
  sink: ShadowHealingSink;
  logger?: { warn: (msg: string, context?: LogContext) => void };
  now: number;
}): void {
  const { otterId, ids, sink, logger, now } = params;
  const c = aggregate;
  sink.create({
    id: crypto.randomUUID(),
    messageId: ids.messageId ?? "",
    conversationId: ids.conversationId ?? "",
    otterId,
    errorType: SHADOW_EVAL_ERROR_TYPE,
    severity: "low",
    description: `shadow_eval 聚合计数（判据③④数据源，窗口 ${new Date(c.windowStart).toISOString().slice(11, 19)}→${new Date(now).toISOString().slice(11, 19)}）：total=${c.total} evaluated=${c.evaluated} unevaluated=${c.unevaluated} mainWriteEval=${c.mainWriteBlockEvaluated} mainWriteFb=${c.mainWriteBlockFallback} dimMismatch=${c.dimensionMismatchBlocked} unknown=${c.unknownBlocked}`,
    suggestion: "聚合计数记录（自动，无需裁决）——全量回落率/族内成功率判据数据源，口径见 F20261010gshw",
    context: {
      layer: "framework",
      kind: "shadow_eval_aggregate",
      ...c,
      windowEnd: now,
      windowStartIso: new Date(c.windowStart).toISOString(),
      windowEndIso: new Date(now).toISOString(),
    },
    status: "open",
    resolution: null,
    createdAt: new Date(now).toISOString(),
    resolvedAt: null,
  }).catch(err => {
    logger?.warn("[shadow-eval] aggregate write failed (non-fatal)", { err: err instanceof Error ? err.message : String(err) });
  });
}

/** 聚合计数更新 + 到窗刷新检查（计时器禁用——守卫路径无副作用定时器，逐调用检查）。
 *  参数打包（#1285 max-params 先例）。 */
interface TrackAggregateCtx {
  command: string;
  oldBlock: string | null;
  outcome: ShadowEvalOutcome;
  now: number;
  logged: boolean;
  flush: { otterId: string; ids: { messageId?: string; conversationId?: string }; sink: ShadowHealingSink; logger?: { warn: (msg: string, context?: LogContext) => void } };
}
function trackAggregate(ctx: TrackAggregateCtx): void {
  const { oldBlock, outcome, now, logged, flush } = ctx;
  if (lastAggregateFlush === 0) { lastAggregateFlush = now; aggregate = emptyCounters(now); }
  aggregate.total += 1;
  if (outcome.unevalReason !== null) aggregate.unevaluated += 1; else aggregate.evaluated += 1;
  if (oldBlock !== null) {
    const rule = classifyGuardInterceptReason(oldBlock);
    if (rule.ruleId === MAIN_WRITE_RULE_ID) {
      if (outcome.unevalReason !== null) aggregate.mainWriteBlockFallback += 1;
      else aggregate.mainWriteBlockEvaluated += 1;
    } else if (rule.ruleId === "unknown") {
      aggregate.unknownBlocked += 1;
    } else {
      aggregate.dimensionMismatchBlocked += 1;
    }
  }
  if (logged) aggregate.individualsLogged += 1;
  const due = now - lastAggregateFlush >= SHADOW_AGGREGATE_FLUSH_MS || aggregate.total >= SHADOW_AGGREGATE_FLUSH_THRESHOLD;
  if (due) {
    emitAggregateEvent({ ...flush, now });
    aggregate = emptyCounters(now);
    lastAggregateFlush = now;
  }
}

/** 测试钩子：重置模块级聚合/防抖状态（单测隔离用，生产不调） */
export function __resetShadowEvalStateForTest(): void {
  recentShadowRecords.clear();
  aggregate = emptyCounters(0);
  lastAggregateFlush = 0;
}

/** S1+S2：个体落账决策（纯函数，可单测）——维度过滤 + 三态分桶。
 *  返回 null = 不落个体（维度外/同判放），计数仍进聚合。 */
export function classifyIndividualSubkind(
  oldBlock: string | null,
  outcome: ShadowEvalOutcome,
): ShadowIndividualSubkind | null {
  if (oldBlock !== null) {
    const rule = classifyGuardInterceptReason(oldBlock);
    if (rule.ruleId !== MAIN_WRITE_RULE_ID) return null; // S1：别族维度拦截不落个体
    if (outcome.unevalReason !== null) return "family_fallback";
    return outcome.evaluatorWouldAllow ? "miss_block_candidate" : "same_block";
  }
  return outcome.evaluatorWouldBlock ? "eval_gain" : null; // 旧链放：仅增益落个体
}

/**
 * 个体落账（防抖后，人工裁决/族内判据面）：
 * - 旧链 **main_write 维度**拦截：全量三态落账（miss_block_candidate /
 *   same_block / family_fallback）——族内成功率逐条证据
 * - EVAL_GAIN（旧链放 + 求值器会拦）：落账不告警
 * - **维度外不落**（S1）：旧链别族维度（sleep/kill/data_destructive…）拦截——
 *   求值器只判写落点，别族拦截+wouldAllow 是维度边界非误拦候选，混入会假触发
 *   「真误放>0 停止切换」红线；计数进聚合的 dimensionMismatchBlocked 可观测
 * - 旧链放 + 求值器放/回落：无信息量不落（计数进聚合）
 *
 * 聚合计数（S2）：全部调用 pre-dedup 计数，按窗落单条聚合记录——全量回落率/
 * 族内成功率（判据③④）数据源。
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
  const subkind = classifyIndividualSubkind(oldBlock, outcome);
  let logged = false;
  if (subkind !== null && !shadowShouldSkip(otterId, command, now)) {
    registerDedup(otterId, command, now);
    emitIndividualEvent({ command, oldBlock, otterId, ids, sink, logger, now, outcome, subkind });
    logged = true;
  }
  trackAggregate({ command, oldBlock, outcome, now, logged, flush: { otterId, ids, sink, logger } });
}
