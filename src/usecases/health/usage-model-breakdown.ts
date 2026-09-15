/**
 * F20260914usgm：用量看板按模型聚合（从 rhi-controller 拆出，守 max-lines 450）。
 *
 * 两个聚合器，数据源均为 health_snapshots 的 cost_output 行：
 * - buildModelBreakdown: per-model token 四分类/调用数/失败数/缓存命中率（窗口累计）
 * - buildInvokeStats: 单次问答均值（per-model + _total，最新快照日）
 *
 * 口径：无 model 或非法 metadata → "unknown"（两处同口径，检视发现 2 处置）。
 */

/** per-model 用量汇总（面板主维度） */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  callCount: number;
  errorCalls: number;
  cacheHitRate: number;
}

/** 单次问答均值（per-model；"_total" 为全模型合计） */
export interface InvokeStats {
  model: string;
  invokeCount: number;
  avgToolCalls: number;
  avgDurationSec: number;
  avgInputTokens: number;
  avgOutputTokens: number;
}

/** metadata → model（无/非法 → "unknown"） */
function extractModelFromMeta(metadata: string | null | undefined): string {
  if (!metadata) return "unknown";
  try {
    return (JSON.parse(metadata) as { model?: string }).model ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** buildModelBreakdown 内部累加器 */
interface ModelUsageAcc {
  inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number;
  totalTokens: number; callCount: number; errorCalls: number;
}

/** 累加一行指标进模型累加器（返回是否命中 MODEL_KEYS） */
function applyModelMetric(m: ModelUsageAcc, key: string, value: number): boolean {
  switch (key) {
    case "input_tokens": m.inputTokens += value; return true;
    case "output_tokens": m.outputTokens += value; return true;
    case "cache_read_tokens": m.cacheRead += value; return true;
    case "cache_write_tokens": m.cacheWrite += value; return true;
    case "total_tokens": m.totalTokens += value; return true;
    case "llm_call_count": m.callCount += value; return true;
    case "error_call_count": m.errorCalls += value; return true;
    default: return false;
  }
}

/** 累加器 → ModelUsage */
function formatModelUsage([model, m]: [string, ModelUsageAcc]): ModelUsage {
  const denom = m.cacheRead + m.inputTokens;
  return {
    model, inputTokens: m.inputTokens, outputTokens: m.outputTokens,
    cacheReadTokens: m.cacheRead, cacheWriteTokens: m.cacheWrite, totalTokens: m.totalTokens,
    callCount: m.callCount, errorCalls: m.errorCalls,
    cacheHitRate: denom > 0 ? Number((m.cacheRead / denom).toFixed(4)) : 0,
  };
}

/** 按模型聚合（面板主维度）——per-model token 四分类/调用数/失败数/缓存命中率。
 *  从窗口内全部 cost_output 行聚合（非仅最新日），token 与调用数为区间累计。 */
export function buildModelBreakdown(
  costRows: Array<{ metric_key: string; metric_value: number; metadata?: string | null }>,
): ModelUsage[] {
  const byModel = new Map<string, ModelUsageAcc>();
  for (const row of costRows) {
    const key = extractModelFromMeta(row.metadata);
    let m = byModel.get(key);
    if (!m) {
      m = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, callCount: 0, errorCalls: 0 };
      byModel.set(key, m);
    }
    applyModelMetric(m, row.metric_key, row.metric_value);
  }
  return [...byModel.entries()].map(formatModelUsage).sort((a, b) => b.totalTokens - a.totalTokens);
}

/** buildInvokeStats 内部累加器 */
interface InvokeStatsSAcc {
  snapshotDate: string;
  invokeCount: number; avgToolCalls: number; avgDurationSec: number;
  avgInputTokens: number; avgOutputTokens: number;
}

/** 累加一行 stats 指标（返回是否命中 STATS_KEYS） */
function applyStatsMetric(s: InvokeStatsSAcc, key: string, value: number): boolean {
  switch (key) {
    case "invoke_count": s.invokeCount = value; return true;
    case "avg_tool_calls": s.avgToolCalls = value; return true;
    case "avg_duration_sec": s.avgDurationSec = value; return true;
    case "avg_input_tokens": s.avgInputTokens = value; return true;
    case "avg_output_tokens": s.avgOutputTokens = value; return true;
    default: return false;
  }
}

/** 单次问答均值——per-model（含 _total 合计）从 invoke stats 行取最新日。 */
export function buildInvokeStats(
  costRows: Array<{ snapshot_date: string; metric_key: string; metric_value: number; metadata?: string | null }>,
): InvokeStats[] {
  const STATS_KEYS = new Set(["invoke_count", "avg_tool_calls", "avg_duration_sec", "avg_input_tokens", "avg_output_tokens"]);
  const byModel = new Map<string, InvokeStatsSAcc>();
  for (const row of costRows) {
    if (!STATS_KEYS.has(row.metric_key)) continue;
    const model = extractModelFromMeta(row.metadata);
    let s = byModel.get(model);
    // 取最新快照日的值（同日多行覆盖后只剩一份；跨日取大）
    if (!s || row.snapshot_date > s.snapshotDate) {
      s = { snapshotDate: row.snapshot_date, invokeCount: 0, avgToolCalls: 0, avgDurationSec: 0, avgInputTokens: 0, avgOutputTokens: 0 };
      byModel.set(model, s);
    }
    applyStatsMetric(s, row.metric_key, row.metric_value);
  }
  return [...byModel.entries()]
    .map(([model, s]) => ({
      model, invokeCount: s.invokeCount, avgToolCalls: s.avgToolCalls,
      avgDurationSec: s.avgDurationSec, avgInputTokens: s.avgInputTokens, avgOutputTokens: s.avgOutputTokens,
    }))
    .sort((a, b) => b.invokeCount - a.invokeCount);
}
