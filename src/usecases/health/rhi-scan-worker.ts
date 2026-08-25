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

/** healing 事件数据源端口（由 bootstrap 注入 DB 查询；worker 不直接依赖 healing repository 细节） */
export type HealingEventSource = () => Promise<CollectedHealingEvent[]>;

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
}

export class RhiScanWorker {
  private timer: NodeJS.Timeout | null = null;
  private inflightTick: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly repoPath: string,
    private readonly pipeline: SignalPipeline,
    private readonly healingSource: HealingEventSource,
    private readonly logger: Logger,
    private readonly options: RhiScanWorkerOptions = {},
  ) {}

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

    return {
      scannedAt,
      commitCount: commitsWithFiles.length,
      chainCount: chains.length,
      signalCount: signals.length,
      stored: pipelineResult.stored,
      memoryIndexed: pipelineResult.memoryIndexed,
      wakeupsTriggered: pipelineResult.wakeupsTriggered,
      errors: pipelineResult.errors,
    };
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
