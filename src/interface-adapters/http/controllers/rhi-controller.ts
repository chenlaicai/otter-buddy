/**
 * RhiController: /api/health/* 端点（F20260825rweb Phase 2 / Issue #402）
 *
 * 三个读端点 + 一个手动扫描端点，数据全部来自 Phase 0/1 的现成结构：
 * - overview: health_snapshots 最新快照 + open 信号计数（含 critical 数）
 * - signals: signals 表（open 优先，可按 status 过滤）
 * - chains:  实时构建特性链（buildFeatureChains 纯函数，读 git + docs）
 * - scan:    手动触发一轮 RhiScanWorker.scanOnce（调试/演示用）
 *
 * 设计：try-catch 兜底返回 200 + error 字段（对齐 memory 端点的守门人模式）。
 */

import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { SignalRepository } from "@usecases/health/signal-repository";
import type { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";
import type { RhiScanWorker } from "@usecases/health/rhi-scan-worker";
import { judgeTrend, DIMENSION_NAMES, statusFromScore } from "@usecases/health/health-score";
import type { DimensionId, TrendDirection } from "@usecases/health/health-score";
import { aggregateOpenSignalCounts } from "@usecases/health/signal-counts";
import { computeFanInExclusions } from "@usecases/health/post-merge-fix-density";

const STALLED_DAYS = 14;
const ZOMBIE_DAYS = 30;

/** Issue #644：JSON 字符串安全解析（evidence_detail 列）——解析失败降级 null 不阻断列表 */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 信号类型中文标签（与前端 SIGNAL_TYPE_LABELS 保持一致；review_debt 虽未发射但保留对齐） */
const SIGNAL_TYPE_LABELS: Record<string, string> = {
  bug_recurrence: 'bug 反复出现',
  chain_stall: '特性链滞留',
  hotspot: '热点文件',
  behavior_defect: '行为缺陷',
  eval_regression: '效果回退',
  intent_drop: '意图兑现率下降',
  hotspot_imbalance: '热区失衡',
  review_debt: '审视债务',
  post_merge_fix_density: '合并后修复密度',
};

/** 特性链五态人话解释（基于 chain-builder.ts 五态判定规则） */
function buildChainStateReason(
  state: string,
  chain: { daysSinceLastCommit: number | null; doc: { status: string | null } | null; bugfixCount: number; commitCount: number },
): string {
  if (state === "orphan") {
    return "commit 提到了特性编号但未找到对应特性文档";
  }
  const docStatus = chain.doc?.status ?? "draft";
  const inFlight = ["draft", "proposed", "design", "development", "active"].includes(docStatus);
  // Why: doc-only 链（有文档无 commit）daysSinceLastCommit=null，不能兜底为 Infinity
  const hasCommits = chain.daysSinceLastCommit !== null;
  const days = chain.daysSinceLastCommit!;

  switch (state) {
    case "active":
      if (!hasCommits) return `文档状态 ${docStatus}，尚未有提交`;
      return inFlight
        ? `文档状态 ${docStatus}，最近 ${days} 天内有提交（阈值 ${STALLED_DAYS} 天）`
        : `文档已终结（${docStatus}），视为稳定`;
    case "stalled":
      if (!hasCommits) return `文档状态 ${docStatus}，有文档但无提交记录`;
      return `文档状态 ${docStatus}，已 ${days} 天无提交（超过 ${STALLED_DAYS} 天阈值）`;
    case "regressed":
      return `最新提交为 BugFix（共 ${chain.bugfixCount} 个），且触碰了链内更早引入的文件`;
    case "zombie":
      if (!hasCommits) return `文档状态 ${docStatus}，有文档但无提交记录，且近期对话中未被提及`;
      return `已 ${days} 天无提交（超过 ${ZOMBIE_DAYS} 天），且近期对话中未被提及`;
    default:
      return "";
  }
}

const OVERVIEW_KEYS = [
  "total_commits", "commits_with_fid", "compliant_commits", "skipped_commits",
  "bugfix_count", "bugfix_ratio", "bugfix_ratio_of_fid",
] as const;

/** trends 序列指标键（F20260829hviz）：折线图趋势专用，比率 ×100 转百分比点位 */
const TREND_KEYS = [
  "total_commits", "bugfix_count", "bugfix_ratio", "compliant_commits",
] as const;

const DEFAULT_TREND_DAYS = 30;

/** 趋势序列聚合：{ date → { key → value } }，比率键 ×100 转百分比（F20260829hviz） */
const RATIO_KEYS = new Set(["bugfix_ratio", "bugfix_ratio_of_fid"]);

function aggregateTrendSeries(rows: Array<{ snapshot_date: string; metric_key: string; metric_value: number }>):
  Array<Record<string, number | string>> {
  const byDate = new Map<string, Record<string, number>>();
  for (const row of rows) {
    if (!TREND_KEYS.includes(row.metric_key as (typeof TREND_KEYS)[number])) continue;
    const point = byDate.get(row.snapshot_date) ?? {};
    point[row.metric_key] = RATIO_KEYS.has(row.metric_key)
      ? Number((row.metric_value * 100).toFixed(2))
      : row.metric_value;
    byDate.set(row.snapshot_date, point);
  }
  return [...byDate.entries()]
    .map(([date, values]) => ({ date, ...values }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 最新一天 distribution 行解析为 { key → parsed JSON }（metadata 坏 JSON 降级 null） */
function parseLatestDistributions(
  rows: Array<{ snapshot_date: string; metric_type: string; metric_key: string; metadata: string | null }>,
  latestDate: string | null,
): Record<string, unknown> {
  if (!latestDate) return {};
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    if (r.metric_type !== "distribution" || r.snapshot_date !== latestDate) continue;
    try {
      out[r.metric_key] = r.metadata ? JSON.parse(r.metadata) : null;
    } catch {
      out[r.metric_key] = null;
    }
  }
  return out;
}

/** 最新一天 health_index 行 → 维度列表 + overall 归因元数据 */
function parseLatestHealthIndex(
  rows: Array<{ snapshot_date: string; metric_key: string; metric_value: number; metadata: string | null }>,
  latestDate: string,
): {
  dims: Array<{ dimension: DimensionId; name: string; score: number; status: string }>;
  overallScore: number | null;
  overallMeta: { attribution?: string | null; overallStatus?: string } | null;
} {
  const dims: Array<{ dimension: DimensionId; name: string; score: number; status: string }> = [];
  let overallScore: number | null = null;
  let overallMeta: { attribution?: string | null; overallStatus?: string } | null = null;
  for (const r of rows) {
    if (r.snapshot_date !== latestDate) continue;
    if (r.metric_key === "overall") {
      overallScore = r.metric_value;
      try {
        overallMeta = r.metadata ? JSON.parse(r.metadata) : null;
      } catch {
        overallMeta = null;
      }
      continue;
    }
    dims.push({
      dimension: r.metric_key as DimensionId,
      name: DIMENSION_NAMES[r.metric_key as DimensionId] ?? r.metric_key,
      score: r.metric_value,
      status: statusFromScore(r.metric_value),
    });
  }
  return { dims, overallScore, overallMeta };
}

/** 每维 + overall 的近 14 天序列 → 走向判定 */
function judgeTrends(
  rows: Array<{ snapshot_date: string; metric_key: string; metric_value: number }>,
  dimensionKeys: string[],
): Partial<Record<DimensionId | "overall", TrendDirection | null>> {
  const trend: Partial<Record<DimensionId | "overall", TrendDirection | null>> = {};
  for (const key of dimensionKeys) {
    const series = rows
      .filter(r => r.metric_key === key)
      .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
      .map(r => r.metric_value);
    trend[key as DimensionId | "overall"] = judgeTrend(series);
  }
  return trend;
}

/** cost_output 趋势序列构建（#583）
 *  cacheHitRate 从 cache_read_tokens + input_tokens 求和推导（真加权平均），
 *  不对 per-record cache_hit_rate 做简单平均（#583 第二轮审视修复：三处口径统一）。 */
function buildCostTrendSeries(
  costRows: Array<{ snapshot_date: string; metric_key: string; metric_value: number }>,
): Array<Record<string, number | string>> {
  const AGGREGATE_KEYS = new Set(["total_tokens", "cost_total", "llm_call_count", "message_count", "cache_read_tokens", "input_tokens"]);
  const byDate = new Map<string, Record<string, number>>();
  for (const row of costRows) {
    if (!AGGREGATE_KEYS.has(row.metric_key)) continue;
    const point = byDate.get(row.snapshot_date) ?? {};
    point[row.metric_key] = (point[row.metric_key] ?? 0) + row.metric_value;
    byDate.set(row.snapshot_date, point);
  }
  return [...byDate.entries()]
    .map(([date, p]) => {
      const cacheRead = p.cache_read_tokens ?? 0;
      const input = p.input_tokens ?? 0;
      return {
        date,
        totalTokens: p.total_tokens ?? 0,
        costTotal: p.cost_total ?? 0,
        callCount: p.llm_call_count ?? 0,
        cacheHitRate: (cacheRead + input) > 0 ? Number((cacheRead / (cacheRead + input)).toFixed(4)) : 0,
        messageCount: p.message_count ?? 0,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** cost_output per-otter 聚合（#583）：从最新一天的行提取 otter 明细 */
/** 从最新一天的行提取 otter 明细（#583） */
function buildCostOtterBreakdown(
  latestRows: Array<{ metric_key: string; metric_value: number; metadata: string | null }>,
): Array<{
  otterId: string; otterName: string; otterType: string;
  totalTokens: number; costTotal: number; callCount: number;
  cacheHitRate: number; messageCount: number;
  models: Array<{ model: string; totalTokens: number; costTotal: number }>;
}> {
  const otterMap = new Map<string, OtterAcc>();
  for (const row of latestRows) {
    const meta = row.metadata ? JSON.parse(row.metadata) as { otterId?: string; otterName?: string; otterType?: string; model?: string } : {};
    const entry = getOrInitOtter(otterMap, meta);
    applyMetricValue(entry, row.metric_key, row.metric_value);
    if (meta.model && MODEL_COST_KEYS.has(row.metric_key)) {
      accumulateModel(entry.models, meta.model, row.metric_key, row.metric_value);
    }
  }
  return [...otterMap.values()].map(formatOtterEntry).sort((a, b) => b.costTotal - a.costTotal);
}

type OtterAcc = {
  otterId: string; otterName: string; otterType: string;
  totalTokens: number; costTotal: number; callCount: number;
  cacheRead: number; cacheInput: number; messageCount: number;
  models: Map<string, { totalTokens: number; costTotal: number }>;
};
const MODEL_COST_KEYS = new Set(["total_tokens", "cost_total"]);
const KEY_FIELD: Record<string, "totalTokens" | "costTotal" | "callCount" | "cacheRead" | "cacheInput" | "messageCount"> = {
  total_tokens: "totalTokens", cost_total: "costTotal",
  llm_call_count: "callCount", cache_read_tokens: "cacheRead", input_tokens: "cacheInput", message_count: "messageCount",
};
function getOrInitOtter(map: Map<string, OtterAcc>, meta: { otterId?: string; otterName?: string; otterType?: string }): OtterAcc {
  const id = meta.otterId ?? "unknown";
  let entry = map.get(id);
  if (!entry) {
    entry = { otterId: id, otterName: meta.otterName ?? id, otterType: meta.otterType ?? "unknown", totalTokens: 0, costTotal: 0, callCount: 0, cacheRead: 0, cacheInput: 0, messageCount: 0, models: new Map() };
    map.set(id, entry);
  }
  return entry;
}
function applyMetricValue(entry: OtterAcc, key: string, value: number): void {
  const field = KEY_FIELD[key];
  if (!field) return;
  entry[field] = (entry[field] as number) + value;
}
function accumulateModel(models: Map<string, { totalTokens: number; costTotal: number }>, model: string, key: string, value: number): void {
  let m = models.get(model);
  if (!m) { m = { totalTokens: 0, costTotal: 0 }; models.set(model, m); }
  if (key === "total_tokens") m.totalTokens += value;
  if (key === "cost_total") m.costTotal += value;
}
function formatOtterEntry(e: OtterAcc) {
  const denom = e.cacheRead + e.cacheInput;
  return {
    otterId: e.otterId, otterName: e.otterName, otterType: e.otterType,
    totalTokens: e.totalTokens, costTotal: Number(e.costTotal.toFixed(6)),
    callCount: e.callCount, cacheHitRate: denom > 0 ? Number((e.cacheRead / denom).toFixed(4)) : 0, messageCount: e.messageCount,
    models: [...e.models.entries()].map(([model, m]) => ({
      model, totalTokens: m.totalTokens, costTotal: Number(m.costTotal.toFixed(6)),
    })).sort((a, b) => b.costTotal - a.costTotal),
  };
}

export class RhiController {
  constructor(
    private readonly snapshotRepo: HealthSnapshotRepository,
    private readonly signalRepo: SignalRepository,
    private readonly scanWorker: RhiScanWorker,
    private readonly logger: Logger,
  ) {}

  /** GET /api/health/overview — 总览：最新快照指标 + 信号计数 */
  async overview(c: Context): Promise<Response> {
    try {
      const metrics: Record<string, number> = {};
      for (const key of OVERVIEW_KEYS) {
        const snap = this.snapshotRepo.findLatestByMetricKey(key);
        if (snap) metrics[key] = snap.metric_value;
      }

      const openSignals = this.signalRepo.findOpen();
      // Issue #652 方案甲：low 不进 severity 计数（数字与视觉折叠一致），单列
      // byConfidence 供低置信抽屉——口径单一真相源 signal-counts.ts（worker D5 同源）
      const { bySeverity, byConfidence } = aggregateOpenSignalCounts(openSignals);

      const latestSnapshotDate = this.snapshotRepo.findLatestByMetricKey("total_commits")?.snapshot_date ?? null;

      return c.json({
        metrics,
        snapshotDate: latestSnapshotDate,
        openSignals: openSignals.length,
        openSignalsBySeverity: bySeverity,
        openSignalsByConfidence: byConfidence,
      });
    } catch (err) {
      this.logger.error("RHI overview failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/signals?status=open — 信号列表（含结构化证据与置信度，Issue #644） */
  async signals(c: Context): Promise<Response> {
    try {
      const status = c.req.query("status") ?? "open";
      const rows = status === "all"
        ? [...this.signalRepo.findOpen(), ...this.signalRepo.findByStatus("resolved"), ...this.signalRepo.findByStatus("dismissed")]
        : this.signalRepo.findByStatus(status);
      return c.json({
        signals: rows.map(s => ({
          ...s,
          signalTypeLabel: SIGNAL_TYPE_LABELS[s.signal_type] ?? s.signal_type,
          // evidence_detail 存 JSON 字符串（可空）——解析失败不阻断列表，降级 null
          evidenceDetail: s.evidence_detail ? safeParseJson(s.evidence_detail) : null,
          evidence_detail: undefined,
        })),
        count: rows.length,
      });
    } catch (err) {
      this.logger.error("RHI signals failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/chains — 特性链列表（实时构建，含五态分布） */
  async chains(c: Context): Promise<Response> {
    try {
      const chains = await this.scanWorker.buildChainsOnce();
      const stateCounts: Record<string, number> = {};
      for (const ch of chains) {
        stateCounts[ch.state] = (stateCounts[ch.state] ?? 0) + 1;
      }
      return c.json({
        chains: chains.map(ch => ({
          featureId: ch.featureId,
          state: ch.state,
          commitCount: ch.commitCount,
          bugfixCount: ch.bugfixCount,
          daysSinceLastCommit: ch.daysSinceLastCommit,
          firstSeenAt: ch.firstSeenAt,
          lastCommitAt: ch.lastCommitAt,
          docStatus: ch.doc?.status ?? null,
          docTitle: ch.doc?.title ?? null,
          stateReason: buildChainStateReason(ch.state, ch),
        })),
        stateCounts,
        total: chains.length,
        // Issue #647：高扇入排除清单常驻可见（验收项：不黑箱）——
        // 与 post_merge_fix_density 信号同源同阈值，见 post-merge-fix-density.ts
        fanInExcludedFiles: computeFanInExclusions(chains),
      });
    } catch (err) {
      this.logger.error("RHI chains failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/chains/:featureId — 链详情（Issue #644：泳道时间线/复发卡的数据源）。
   *  commits 数组为全类型序列（时间升序），供 PR3 泳道 SVG 与链详情抽屉消费。 */
  async chainDetail(c: Context): Promise<Response> {
    try {
      const featureId = c.req.param("featureId");
      const chains = await this.scanWorker.buildChainsOnce();
      const ch = chains.find(x => x.featureId === featureId);
      if (!ch) {
        return c.json({ error: `chain not found: ${featureId}` }, 404);
      }
      return c.json({
        chain: {
          featureId: ch.featureId,
          state: ch.state,
          commitCount: ch.commitCount,
          bugfixCount: ch.bugfixCount,
          daysSinceLastCommit: ch.daysSinceLastCommit,
          firstSeenAt: ch.firstSeenAt,
          lastCommitAt: ch.lastCommitAt,
          docStatus: ch.doc?.status ?? null,
          docTitle: ch.doc?.title ?? null,
          stateReason: buildChainStateReason(ch.state, ch),
          // 链上全类型 commit 序列（时间升序，带 changeType + files）——泳道节点/复发卡的直接数据源
          commits: ch.commits.map(cm => ({
            sha: cm.sha.slice(0, 8),
            date: cm.date.toISOString(),
            changeType: cm.changeType,
            message: cm.message,
            filesChanged: cm.filesChanged,
          })),
        },
      });
    } catch (err) {
      this.logger.error("RHI chain detail failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/trends?days=30 — 历史趋势序列（F20260829hviz）
   *  从 health_snapshots 按日期范围拉取趋势指标 + 最新一天的 distribution 行
   *  （change_types / modules / chain_states，供环形图/堆叠条/条形图）。 */
  async trends(c: Context): Promise<Response> {
    try {
      const days = Math.min(Math.max(Number(c.req.query("days")) || DEFAULT_TREND_DAYS, 1), 90);
      const startDate = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      const rows = this.snapshotRepo.findByDateRange(startDate, new Date().toISOString().slice(0, 10));
      const series = aggregateTrendSeries(rows);
      const latestDate = rows.length > 0 ? rows[rows.length - 1]!.snapshot_date : null;
      const distributions = parseLatestDistributions(rows, latestDate);

      return c.json({
        days,
        series,
        distributions,
        latestSnapshotDate: latestDate,
      });
    } catch (err) {
      this.logger.error("RHI trends failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/score — 健康指标（issue #595 PR1）：最新维度分 + 状态 + 走向 + 拖累归因
   *  数据源 health_index 行（worker 旁路写入）；未上线路径返回空态（面板显示「—」）。 */
  async score(c: Context): Promise<Response> {
    try {
      const startDate = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const rows = this.snapshotRepo
        .findByDateRange(startDate, new Date().toISOString().slice(0, 10))
        .filter(r => r.metric_type === "health_index");

      if (rows.length === 0) {
        return c.json({ available: false, snapshotDate: null, overall: null, overallStatus: null, dimensions: [], trend: {}, attribution: null });
      }

      const latestDate = rows[rows.length - 1]!.snapshot_date;
      const { dims, overallScore, overallMeta } = parseLatestHealthIndex(rows, latestDate);
      const trend = judgeTrends(rows, [...dims.map(d => d.dimension), "overall"]);

      return c.json({
        available: true,
        snapshotDate: latestDate,
        overall: overallScore,
        overallStatus: overallMeta?.overallStatus ?? (overallScore !== null ? statusFromScore(overallScore) : null),
        dimensions: dims,
        trend,
        attribution: overallMeta?.attribution ?? null,
      });
    } catch (err) {
      this.logger.error("RHI score failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/health/cost-output?days=30&includeAllOtters=false — 成本/产出趋势序列（#583）
   *  从 health_snapshots 按日期范围拉取 cost_output 指标，聚合出：
   *  - per-date 趋势（总 token / 总 cost / 调用数 / 缓存命中率 / 产出数），camelCase 统一响应格式
   *  - per-otter 明细（最新一天的 per-otter per-model 拆分，默认仅 active 獭）
   *  - 汇总（最新一天的总计）
   *  成本/产出只作信号不作 KPI（Goodhart 防线）。 */
  async costOutput(c: Context): Promise<Response> {
    try {
      const days = Math.min(Math.max(Number(c.req.query("days")) || DEFAULT_TREND_DAYS, 1), 90);
      const includeAllOtters = c.req.query("includeAllOtters") === "true";
      const startDate = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const endDate = new Date().toISOString().slice(0, 10);

      const costRows = this.snapshotRepo.findByDateRange(startDate, endDate).filter(r => r.metric_type === "cost_output");
      const series = buildCostTrendSeries(costRows);

      const latestDate = costRows.length > 0
        ? [...costRows].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))[costRows.length - 1]!.snapshot_date
        : null;
      let otters = latestDate ? buildCostOtterBreakdown(costRows.filter(r => r.snapshot_date === latestDate)) : [];

      // 默认只展示 active 獭，includeAllOtters=true 展示全部（#583 建议3）
      if (!includeAllOtters) {
        const activeIds = new Set(this.snapshotRepo.findActiveOtterIds());
        otters = otters.filter(o => activeIds.has(o.otterId));
      }

      const totals = {
        totalTokens: otters.reduce((s, o) => s + o.totalTokens, 0),
        costTotal: Number(otters.reduce((s, o) => s + o.costTotal, 0).toFixed(6)),
        callCount: otters.reduce((s, o) => s + o.callCount, 0),
        messageCount: otters.reduce((s, o) => s + o.messageCount, 0),
        otterCount: otters.length,
        dispatchCount: costRows.filter(r => r.metric_key === 'dispatch_count').reduce((s, r) => s + r.metric_value, 0),
      };

      return c.json({ days, series, otters, totals, latestSnapshotDate: latestDate });
    } catch (err) {
      this.logger.error("RHI cost-output failed", err instanceof Error ? err : undefined);
      return c.json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** POST /api/health/scan — 手动触发一轮扫描（调试/演示；worker 每小时自动跑） */
  async scan(c: Context): Promise<Response> {
    try {
      const result = await this.scanWorker.scanOnce();
      return c.json({ ok: true, result });
    } catch (err) {
      this.logger.error("RHI manual scan failed", err instanceof Error ? err : undefined);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
