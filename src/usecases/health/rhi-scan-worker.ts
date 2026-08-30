/**
 * RhiScanWorker: RHI 定时采集 worker（Issue #401）
 *
 * 周期执行完整管道：git 采集 → commit 解析 → F 文档采集 → 特性链构建
 *   → 信号检测 → SignalPipeline（落库 + 记忆通道 + critical 唤醒）。
 *
 * 设计参考 EmbeddingRetryWorker：
 * - start()/stop() 生命周期，stop 清 timer + await inflight（防对已关 DB 写入）
 * - inflightTick 防重入（上一轮没跑完不叠加下一轮）
 * - 单轮失败不抛出（记录日志，下一轮重试）——传感器阵列不能因单轮故障停摆
 *
 * 采集频率：默认 1h（特性文档：仓库"心率"没那么快，小时级足够）。
 */

import type { Logger } from "@usecases/ports/logger";
import type Database from "better-sqlite3";
import { collectGitLogWithFiles } from "./git-log-collector";
import { parseCommits } from "./commit-parser";
import { collectFeatureDocs } from "./feature-doc-collector";
import { buildFeatureChains } from "./chain-builder";
import { detectSignals } from "./detect-signals";
import type { DetectedSignal } from "./detect-signals";
import type { SignalPipeline, CriticalSignalWakeup } from "./signal-pipeline";
import type { CollectedHealingEvent } from "./healing-collector";
import type { ParsedCommit } from "./commit-parser";
import type { CollectedFeatureDoc } from "./feature-doc-collector";
import { calculateMetrics } from "./metrics-calculator";
import { buildOverviewSnapshotRows } from "./snapshot-rows";
import type { CreateSnapshotRow } from "./snapshot-rows";
import { computeHealthScore, buildHealthIndexRows } from "./health-score";
import type { SignalRepository } from "./signal-repository";
import { collectLlmCalls, collectOtterOutput, collectToolCallCounts, collectPrCounts, collectFdocCounts, collectDispatchTaskCounts } from "./cost-output-collector";
import type { AgentSessionSource } from "./cost-output-collector";
import { buildCostOutputSnapshotRows } from "./cost-output-rows";
import type { CreateCostOutputRow } from "./cost-output-rows";

/** healing 事件数据源端口（由 bootstrap 注入 DB 查询；worker 不直接依赖 healing repository 细节） */
export type HealingEventSource = () => Promise<CollectedHealingEvent[]>;

/** 指标快照落库端口（F20260829hviz Fix A）：接收快照日期 + 行集，同日覆盖写入。
 *  由 bootstrap 注入 HealthSnapshotRepository.replaceForDate；测试可注入内存实现。
 *  @param metricType 可选，指定后只删除该 metric_type 的行（#583 修复：避免误删其他类型数据）。 */
export type SnapshotSink = (snapshotDate: string, rows: CreateSnapshotRow[], metricType?: string) => void;

export interface RhiScanWorkerOptions {
  /** 扫描间隔（默认 1h） */
  intervalMs?: number;
  /** 统计基准分支（默认 main，透传 collectGitLogWithFiles） */
  ref?: string;
  /** 信号检测窗口天数（默认 30，透传 detectSignals） */
  windowDays?: number;
  /** critical 信号唤醒回调（SignalPipeline 用） */
  wakeup?: CriticalSignalWakeup;
  /** FID 提及计数源（zombie 判定数据源，F20260825sgnw 审视发现 2：
   *  未注入时 zombie 不判（降级 stalled），注入后对 stalled 候选二次判定） */
  fidMentionSource?: (fids: string[], windowDays: number) => Promise<Map<string, number>>;
  /** zombie 判定的提及窗口天数（默认 30，母文档口径） */
  mentionWindowDays?: number;
  /** zombie 阈值天数（透传 buildFeatureChains，默认 30） */
  zombieDays?: number;
  /** 指标快照落库端口（F20260829hviz Fix A）：注入后 scanOnce 会计算指标并写入 health_snapshots。
   *  未注入时跳过（向后兼容，旧测试/CLI 直调不受影响）。 */
  snapshotSink?: SnapshotSink;
  /** 成本/产出快照落库端口（#583）：注入后 scanOnce 采集成本/产出数据写入 health_snapshots。
   *  与 overview snapshotSink 分离，避免类型冲突。未注入时跳过。
   *  @param metricType 可选，指定后只删除该 metric_type 的行（#583 修复：全局行按历史日期分批写入需类型限定）。 */
  costOutputSink?: (snapshotDate: string, rows: CreateCostOutputRow[], metricType?: string) => void;
  /** 指标计算滚动窗口天数（默认 60：趋势图 30 天 + 前后各 15 天缓冲） */
  metricsWindowDays?: number;
  /** 信号仓库（可选，issue #595 PR1）：注入后健康评分 D5 用真实 open 计数；未注入时降级零值 */
  signalRepo?: SignalRepository;
  /** session JSONL 目录路径（#583：LLM 成本采集数据源）。未注入时跳过成本采集。 */
  sessionsDir?: string;
  /** agent_sessions → otter 映射数据源（#583）。注入后从 session JSONL 关联到 otterId。 */
  agentSessionSource?: AgentSessionSource;
  /** 成本/产出 DB 句柄（#583：OtterOutputCollector 需要查 messages 表）。 */
  costOutputDb?: Database.Database;
}

export interface RhiScanResult {
  scannedAt: string;
  commitCount: number;
  chainCount: number;
  signalCount: number;
  stored: number;
  memoryIndexed: number;
  wakeupsTriggered: number;
  errors: string[];
  /** 写入 health_snapshots 的指标行数（F20260829hviz；未注入 sink 时为 0） */
  metricsStored: number;
  /** 写入 health_snapshots 的成本/产出行数（#583；未注入 costOutputSink 时为 0） */
  costOutputStored: number;
}

export class RhiScanWorker {
  private timer: NodeJS.Timeout | null = null;
  private inflightTick: Promise<void> | null = null;
  private stopped = true;
  /** 最近一轮扫描后的 open 信号计数（health_index D5 输入；signalRepo 未注入时恒 null） */
  private lastOpenSignalCounts: { critical: number; warning: number } | null = null;

  constructor(
    private readonly repoPath: string,
    private readonly pipeline: SignalPipeline,
    private readonly healingSource: HealingEventSource,
    private readonly logger: Logger,
    private readonly options: RhiScanWorkerOptions = {},
  ) {}

  /** open 信号按 severity 计数（D5 输入；repo 未注入返回 null → 评分降级零值） */
  private countOpenBySeverity(): { critical: number; warning: number } | null {
    if (!this.options.signalRepo) return null;
    try {
      const open = this.options.signalRepo.findOpen();
      const counts = { critical: 0, warning: 0 };
      for (const s of open) {
        if (s.severity === "critical") counts.critical++;
        else counts.warning++;
      }
      return counts;
    } catch {
      return null;
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const interval = this.options.intervalMs ?? 60 * 60 * 1000;
    this.timer = setInterval(() => {
      this.inflightTick = this.tickSafely();
    }, interval);
    this.logger.info("RHI scan worker started", { action: "rhi_worker_start", intervalMs: interval });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflightTick) await this.inflightTick;
    this.logger.info("RHI scan worker stopped", { action: "rhi_worker_stop" });
  }

  /** 仅构建特性链（不检测信号不落库）——Phase 2 /api/health/chains 端点用。
   *  采集+解析+两阶段 zombie 判定与 scanOnce 同逻辑，保证面板看到的链与信号同源。 */
  async buildChainsOnce(): Promise<ReturnType<typeof buildFeatureChains>> {
    const commitsWithFiles = await collectGitLogWithFiles(this.repoPath, {
      ref: this.options.ref,
      since: this.isoDaysAgo((this.options.windowDays ?? 30) + 30),
    });
    const parsed = parseCommits(commitsWithFiles.map(({ sha, message }) => ({ sha, message })));
    const signalInputs = commitsWithFiles.map((c, i) => ({
      sha: c.sha,
      date: c.date,
      message: c.message,
      parsed: parsed[i]!,
      filesChanged: c.filesChanged,
    }));
    const docs = await collectFeatureDocs(this.repoPath);
    return this.buildChainsWithZombieJudging(signalInputs, docs);
  }

  /** 单轮扫描（可独立调用，CLI/测试用） */
  async scanOnce(): Promise<RhiScanResult> {
    const scannedAt = new Date().toISOString();

    // 1. 采集：git log（默认 main 分支）
    const commitsWithFiles = await collectGitLogWithFiles(this.repoPath, {
      ref: this.options.ref,
      since: this.isoDaysAgo((this.options.windowDays ?? 30) + 30), // 窗口 + 链构建余量
    });

    // 2. 解析
    const parsed = parseCommits(commitsWithFiles.map(({ sha, message }) => ({ sha, message })));

    // 3. 合并成信号输入（parsed 与 commitsWithFiles 按序对齐）
    const signalInputs = commitsWithFiles.map((c, i) => ({
      sha: c.sha,
      date: c.date,
      message: c.message,
      parsed: parsed[i]!,
      filesChanged: c.filesChanged,
    }));

    // 4. F 文档 + healing 事件
    const [docs, healingEvents] = await Promise.all([
      collectFeatureDocs(this.repoPath),
      this.healingSource().catch(err => {
        this.logger.warn("Healing source failed, continuing without it", {
          action: "rhi_worker_healing_source_error",
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as CollectedHealingEvent[];
      }),
    ]);

    // 5. 链构建（两阶段 zombie 判定，F20260825sgnw 审视发现 2）+ 信号检测
    const chains = await this.buildChainsWithZombieJudging(signalInputs, docs);
    const signals: DetectedSignal[] = detectSignals(signalInputs, chains, healingEvents, {
      windowDays: this.options.windowDays,
    });

    // 6. 管道：落库 + 记忆 + 唤醒
    const pipelineResult = await this.pipeline.process(signals, this.options.wakeup);

    // 6.5 记录 open 信号计数（health_index D5 输入：本次扫描后的真实余压）
    this.lastOpenSignalCounts = this.countOpenBySeverity() ?? { critical: 0, warning: 0 };

    // 7. 指标计算 + 快照落库（F20260829hviz Fix A：修「面板扫描不写指标」断链）
    //    独立窗口重采（60 天滚动）而非复用信号窗口——趋势口径要稳定，链构建余量会污染分子分母
    const metricsStored = this.persistSnapshot(signalInputs, chains);

    // 8. 成本/产出快照落库（#583）：与 overview 指标同日写入，独立 sink
    const costOutputStored = await this.persistCostOutputSnapshot();

    return {
      scannedAt,
      commitCount: commitsWithFiles.length,
      chainCount: chains.length,
      signalCount: signals.length,
      stored: pipelineResult.stored,
      memoryIndexed: pipelineResult.memoryIndexed,
      wakeupsTriggered: pipelineResult.wakeupsTriggered,
      errors: pipelineResult.errors,
      metricsStored,
      costOutputStored,
    };
  }

  /** 成本/产出快照写入（#583）：解析 session JSONL + 查 messages 表，同日覆盖。
   *  独立于 overview 快照（metric_type=cost_output），失败不阻断信号管道。 */
  private async persistCostOutputSnapshot(): Promise<number> {
    const sink = this.options.costOutputSink;
    const sessionsDir = this.options.sessionsDir;
    const agentSource = this.options.agentSessionSource;
    const db = this.options.costOutputDb;
    if (!sink || !sessionsDir || !agentSource || !db) return 0;

    try {
      const snapshotDate = new Date().toISOString().slice(0, 10);
      const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const [costRecords, toolCallCounts, prRecords, fdocRecords] = await Promise.all([
        collectLlmCalls(sessionsDir, agentSource, { since }),
        collectToolCallCounts(sessionsDir, agentSource, { since }),
        collectPrCounts(this.repoPath),
        collectFdocCounts(this.repoPath),
      ]);
      const dispatchRecords = collectDispatchTaskCounts(db, { since });

      const outputRecords = collectOtterOutput(db, toolCallCounts, { since });
      const rows = buildCostOutputSnapshotRows(snapshotDate, costRecords, outputRecords, { prRecords, fdocRecords, dispatchRecords });
      if (rows.length > 0) {
        // 按日期分批写入，每批用 metricType="cost_output" 限定删除范围
        // 修复 S1：全局行（pr/fdoc/dispatch）按历史日期入库，replaceForDate 需逐日删除再插入
        // metricType 参数避免误删同日 overview 行
        const rowsByDate = new Map<string, CreateCostOutputRow[]>();
        for (const row of rows) {
          const dateRows = rowsByDate.get(row.snapshotDate) ?? [];
          dateRows.push(row);
          rowsByDate.set(row.snapshotDate, dateRows);
        }
        for (const [date, dateRows] of rowsByDate) {
          sink(date, dateRows, "cost_output");
        }
      }
      return rows.length;
    } catch (err) {
      // 成本/产出采集失败不阻断信号管道（与 overview 指标相同的传感器分离策略）
      this.logger.warn("Cost/output snapshot failed, signals already stored", {
        action: "rhi_worker_cost_output_error",
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /** 指标快照写入：60 天滚动窗口重算 + 11 标准行 + chain_states 行，同日覆盖。
   *  与链/信号共用 signalInputs 采集结果但窗口独立（metricsWindowDays）。 */
  private persistSnapshot(
    signalInputs: Array<{ sha: string; date: string; message: string; parsed: ParsedCommit; filesChanged: string[] }>,
    chains: ReturnType<typeof buildFeatureChains>,
  ): number {
    const sink = this.options.snapshotSink;
    if (!sink) return 0;
    try {
      const windowDays = this.options.metricsWindowDays ?? 60;
      const windowStart = this.isoDaysAgo(windowDays);
      const windowInputs = signalInputs.filter(c => c.date >= windowStart);
      const metrics = calculateMetrics(
        windowInputs.map(c => c.parsed),
        windowInputs.map(c => ({ sha: c.sha, date: c.date, message: c.message, filesChanged: c.filesChanged })),
      );

      // 特性链五态分布行（链构建的独有产物，CLI 不写这行——它不建链）
      const stateCounts: Record<string, number> = {};
      for (const ch of chains) {
        stateCounts[ch.state] = (stateCounts[ch.state] ?? 0) + 1;
      }
      const snapshotDate = new Date().toISOString().slice(0, 10);
      const chainStatesRow: CreateSnapshotRow = {
        snapshotDate, // 行内日期必须真实填写：replaceForDate 的 INSERT 用行内字段，空串会插出无日期行
        metricType: "distribution",
        metricKey: "chain_states",
        metricValue: chains.length,
        metadata: JSON.stringify(stateCounts),
      };

      const rows = buildOverviewSnapshotRows({
        snapshotDate,
        metrics,
        extraRows: [chainStatesRow],
      });

      // 健康指标旁路（issue #595）：五维评分纯函数复用同一份 metrics + 链数据，
      // 输出 health_index 行追加在标准行之后——评分失败与快照失败同降级（传感器分离）
      try {
        const score = computeHealthScore({
          snapshotDate,
          bugfixRatio: metrics.bugfixRatio,
          totalCommits: metrics.totalCommits,
          compliantCommits: metrics.compliantCommits,
          hotspotFiles: metrics.fileHotspots,
          changeTypes: metrics.changeTypeDistribution,
          chainStates: stateCounts,
          openSignals: this.lastOpenSignalCounts ?? { critical: 0, warning: 0 },
        });
        rows.push(...buildHealthIndexRows(score));
      } catch (scoreErr) {
        this.logger.warn("RHI health score computation failed, metrics snapshot continues", {
          action: "rhi_worker_health_score_error",
          error: scoreErr instanceof Error ? scoreErr.message : String(scoreErr),
        });
      }

      sink(snapshotDate, rows);
      return rows.length;
    } catch (err) {
      // 快照失败不阻断信号管道（传感器分离：指标是旁路，不是主路）
      this.logger.warn("RHI metrics snapshot failed, signals already stored", {
        action: "rhi_worker_snapshot_error",
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /** 两阶段链构建：先无提及数据粗筛，再对 stalled≥zombieDays 候选查提及重判。
   *  未注入源 / 查询失败 → zombie 不判（降级 stalled，冷启动安全）；
   *  查询成功 → 候选全部进 Map（缺 key 兜底 0），isZombie 的 has(fid) 语义成立。 */
  private async buildChainsWithZombieJudging(
    signalInputs: Array<{ sha: string; date: string; message: string; parsed: ParsedCommit; filesChanged: string[] }>,
    docs: CollectedFeatureDoc[],
  ): Promise<ReturnType<typeof buildFeatureChains>> {
    const zombieDays = this.options.zombieDays ?? 30;
    const mentionWindow = this.options.mentionWindowDays ?? 30;
    const firstPass = buildFeatureChains(signalInputs, docs, { zombieDays });
    if (!this.options.fidMentionSource) return firstPass;

    const candidates = firstPass.filter(c => c.state === "stalled" && (c.daysSinceLastCommit ?? 0) >= zombieDays);
    if (candidates.length === 0) return firstPass;

    const mentions = await this.options
      .fidMentionSource(candidates.map(c => c.featureId), mentionWindow)
      .catch(err => {
        this.logger.warn("fidMentionSource failed, zombie judging degraded to stalled-only", {
          action: "rhi_worker_mention_source_error",
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    if (!mentions) return firstPass;

    const filled = new Map(mentions);
    for (const c of candidates) {
      if (!filled.has(c.featureId)) filled.set(c.featureId, 0);
    }
    return buildFeatureChains(signalInputs, docs, { zombieDays, fidMentionCounts: filled });
  }

  private async tickSafely(): Promise<void> {
    try {
      const result = await this.scanOnce();
      this.logger.info("RHI scan tick completed", {
        action: "rhi_worker_tick",
        commits: result.commitCount,
        chains: result.chainCount,
        signals: result.signalCount,
        stored: result.stored,
        errors: result.errors.length,
      });
    } catch (err) {
      // 单轮失败不抛出：记录后等下一轮（传感器不停摆）
      this.logger.error("RHI scan tick failed", err instanceof Error ? err : undefined, {
        action: "rhi_worker_tick_error",
      });
    }
  }

  private isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }
}
