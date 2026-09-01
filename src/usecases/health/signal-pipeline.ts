/**
 * SignalPipeline: 信号管道编排（Issue #400 记忆通道）
 *
 * Signal 产生 →（1）落库 signals 表（upsert occurrences）
 *            →（2）critical 信号写记忆系统（StoreMemory，search_memory 可检索）
 *            →（3）critical 唤醒回调（Phase 1 由调用方注入 create_scheduled_task 桥，本层只留端口）
 *
 * 哲学（特性文档）：面板是传感器阵列不是自动驾驶——信号只触发，处置走 skill chain + 搭档终审。
 */

import type { Logger } from "@usecases/ports/logger";
import type Database from "better-sqlite3";
import { SignalRepository } from "./signal-repository";
import type { DetectedSignal } from "./detect-signals";
import type { MemoryWriter } from "@usecases/memory/memory-writer";
import type { MemoryQueue } from "@usecases/memory/memory-queue";
import type { EmbeddingGateway } from "@usecases/memory/embedding-gateway";
import { StoreMemory } from "@usecases/memory/store-memory";

/** critical 信号唤醒端口（#400 第 3 步：create_scheduled_task 桥由 bootstrap 注入，本层不依赖 agent 工具） */
export interface CriticalSignalWakeup {
  (signal: DetectedSignal, signalRecordId: number): Promise<void>;
}

export interface SignalPipelineResult {
  stored: number;
  memoryIndexed: number;
  wakeupsTriggered: number;
  errors: string[];
}

export class SignalPipeline {
  private readonly storeMemory: StoreMemory;
  private readonly signalRepo: SignalRepository;

  constructor(
    db: Database.Database,
    writer: MemoryWriter,
    queue: MemoryQueue,
    embeddingGateway: EmbeddingGateway,
    private readonly logger: Logger,
  ) {
    this.storeMemory = new StoreMemory(writer, queue, embeddingGateway, logger);
    this.signalRepo = new SignalRepository(db);
  }

  /**
   * 处理一批检测出的信号：落库 + critical 记忆通道 + critical 唤醒。
   * 单信号失败不阻断批次（传感器不能因一路故障全停）。
   */
  async process(
    signals: DetectedSignal[],
    wakeup?: CriticalSignalWakeup,
  ): Promise<SignalPipelineResult> {
    const result: SignalPipelineResult = { stored: 0, memoryIndexed: 0, wakeupsTriggered: 0, errors: [] };

    const detectedKeys = new Set<string>();

    for (const signal of signals) {
      try {
        await this.processOne(signal, wakeup, result);
        detectedKeys.add(`${signal.type}\u0000${signal.featureId ?? ""}\u0000${signal.filePath ?? ""}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Signal pipeline item failed: ${signal.type}`, {
          action: "signal_pipeline_item_error",
          error: msg,
        });
        result.errors.push(`${signal.type}: ${msg}`);
      }
    }

    // Auto-resolve: signals that are open but weren't detected in this scan
    const resolvedCount = this.resolveStaleSignals(detectedKeys);

    this.logger.info("Signal pipeline processed", {
      action: "signal_pipeline_complete",
      stored: result.stored,
      memoryIndexed: result.memoryIndexed,
      wakeups: result.wakeupsTriggered,
      resolved: resolvedCount,
      errors: result.errors.length,
    });

    return result;
  }

  /** 单信号处理：落库 + critical 记忆通道 + critical 唤醒（Issue #644 重构拆出，行为不变） */
  private async processOne(
    signal: DetectedSignal,
    wakeup: CriticalSignalWakeup | undefined,
    result: SignalPipelineResult,
  ): Promise<void> {
    const record = this.signalRepo.upsert({
      signalType: signal.type,
      severity: signal.severity,
      featureId: signal.featureId,
      filePath: signal.filePath,
      evidence: signal.evidence,
      suggestedAction: signal.suggestedAction,
      // Issue #644：detail/confidence 透传落库（未传时旧值保留）
      evidenceDetail: signal.detail,
      confidence: signal.confidence,
    });
    result.stored++;

    if (signal.severity !== "critical") return;

    await this.storeMemory.execute({
      layer: "working",
      contentType: "fact",
      sourceId: String(record.id),
      sourceTable: "signals",
      granularity: "coarse",
      content: `[RHI信号][${signal.severity}] ${signal.name}：${signal.evidence}（建议：${signal.suggestedAction}）`,
      metadata: {
        signal_type: signal.type,
        severity: signal.severity,
        feature_id: signal.featureId,
        file_path: signal.filePath,
      },
    });
    result.memoryIndexed++;

    if (wakeup) {
      await wakeup(signal, record.id);
      result.wakeupsTriggered++;
    }
  }

  /**
   * 自动 resolve 不再触发的信号：
   * 信号生命周期应与实际问题状态一致——问题消失后信号应自动关闭，而非永久 open。
   */
  private resolveStaleSignals(detectedKeys: Set<string>): number {
    const openSignals = this.signalRepo.findOpen();
    let resolvedCount = 0;
    for (const open of openSignals) {
      const key = `${open.signal_type}\u0000${open.feature_id ?? ""}\u0000${open.file_path ?? ""}`;
      if (!detectedKeys.has(key)) {
        this.signalRepo.resolve(open.id);
        resolvedCount++;
      }
    }
    return resolvedCount;
  }

  /** 查询 open 信号（面板/CLI 消费） */
  listOpen() {
    return this.signalRepo.findOpen();
  }
}
