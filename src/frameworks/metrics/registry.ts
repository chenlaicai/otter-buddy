/**
 * Metric Registry — 全局 metric 注册中心
 *
 * 基于 prom-client 提供 Counter / Histogram / Gauge 标准化 API。
 * 持久化策略：内存累积 + 定期 flush 到 JSONL 文件 + 自动过期清理。
 *
 * 设计要点：
 * - 单例 registry，所有 metric 通过 register* 工厂方法注册，避免重复创建
 * - 文件路径可注入（测试用临时目录）
 * - flush 间隔可配置（默认 60s）
 * - 启动时清理超过 maxAgeDays 的旧文件
 *
 * Why 文件持久化而非 SQLite：metric 数据量大、写入频繁、按时间序列消费；
 * 业务 DB 不应承担运维指标的写入压力。文件易归档/导入/清理。
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Logger } from "@usecases/ports/logger";
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
  type CounterConfiguration,
  type HistogramConfiguration,
  type GaugeConfiguration,
} from "prom-client";

export interface MetricsOptions {
  /** metric 文件目录，默认 ./data/metrics */
  dir?: string;
  /** flush 间隔（毫秒），默认 60s */
  flushIntervalMs?: number;
  /** 文件保留天数，默认 7 */
  maxAgeDays?: number;
  /** 启用默认 Node.js metric（GC、event loop 等），默认 false */
  enableDefaultMetrics?: boolean;
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_MAX_AGE_DAYS = 7;

export class MetricsRegistry {
  private readonly registry: Registry;
  private readonly dir: string;
  private readonly flushIntervalMs: number;
  private readonly maxAgeDays: number;
  private readonly logger: Logger;
  private flushTimer: NodeJS.Timeout | undefined;
  private counters = new Map<string, Counter<string>>();
  private histograms = new Map<string, Histogram<string>>();
  private gauges = new Map<string, Gauge<string>>();

  constructor(logger: Logger, options: MetricsOptions = {}) {
    this.registry = new Registry();
    this.dir = options.dir ?? "./data/metrics";
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    this.logger = logger;

    if (options.enableDefaultMetrics) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  /** 注册或返回已存在的 Counter */
  counter<T extends string>(config: CounterConfiguration<T>): Counter<string> {
    const existing = this.counters.get(config.name);
    if (existing) return existing;
    const c = new Counter({ ...config, registers: [this.registry] });
    this.counters.set(config.name, c as unknown as Counter<string>);
    return c as unknown as Counter<string>;
  }

  /** 注册或返回已存在的 Histogram */
  histogram<T extends string>(config: HistogramConfiguration<T>): Histogram<string> {
    const existing = this.histograms.get(config.name);
    if (existing) return existing;
    const h = new Histogram({ ...config, registers: [this.registry] });
    this.histograms.set(config.name, h as unknown as Histogram<string>);
    return h as unknown as Histogram<string>;
  }

  /** 注册或返回已存在的 Gauge */
  gauge<T extends string>(config: GaugeConfiguration<T>): Gauge<string> {
    const existing = this.gauges.get(config.name);
    if (existing) return existing;
    const g = new Gauge({ ...config, registers: [this.registry] });
    this.gauges.set(config.name, g as unknown as Gauge<string>);
    return g as unknown as Gauge<string>;
  }

  /** 启动：清理旧文件 + 启动定期 flush */
  start(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.cleanupOldFiles();
    this.flushTimer = setInterval(() => {
      this.flush().catch(err => {
        this.logger.error("Metrics flush failed", err instanceof Error ? err : undefined);
      });
    }, this.flushIntervalMs);
    // unref：不阻塞进程退出（dispose 时会显式 flush）
    this.flushTimer.unref?.();
    this.logger.info("MetricsRegistry started", {
      dir: this.dir,
      flushIntervalMs: this.flushIntervalMs,
      maxAgeDays: this.maxAgeDays,
    });
  }

  /** 进程退出时调用：强制 flush */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
    this.registry.clear();
  }

  /** Prometheus 文本格式输出（供 /metrics 端点） */
  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  /** JSON 快照（供 /api/metrics/snapshot） */
  async metricsJSON(): Promise<unknown> {
    return this.registry.getMetricsAsJSON();
  }

  /** 立即写入当前快照到今日文件 */
  async flush(): Promise<void> {
    const values = await this.registry.getMetricsAsJSON();
    if (values.length === 0) return;

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const filePath = path.join(this.dir, `metrics-${date}.jsonl`);
    const ts = new Date().toISOString();

    const lines: string[] = [];
    for (const m of values as unknown as Array<Record<string, unknown>>) {
      const name = m.name as string;
      const valuesArr = m.values as Array<{ labels?: Record<string, string>; value: number }> | undefined;
      if (!valuesArr) continue;
      for (const v of valuesArr) {
        lines.push(JSON.stringify({
          ts,
          metric: name,
          labels: v.labels ?? {},
          value: v.value,
        }));
      }
    }
    if (lines.length === 0) return;

    fs.appendFileSync(filePath, lines.join("\n") + "\n", { encoding: "utf-8" });
  }

  /** 清理超过 maxAgeDays 的文件 */
  private cleanupOldFiles(): void {
    if (!fs.existsSync(this.dir)) return;
    const cutoff = Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const entry of fs.readdirSync(this.dir)) {
      if (!entry.startsWith("metrics-") || !entry.endsWith(".jsonl")) continue;
      const fullPath = path.join(this.dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          cleaned++;
        }
      } catch (err) {
        this.logger.warn("Failed to clean old metrics file", {
          file: entry,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (cleaned > 0) {
      this.logger.info("Cleaned old metrics files", { count: cleaned, maxAgeDays: this.maxAgeDays });
    }
  }
}

// ── 全局单例 ──
// Why 单例：metric 是跨模块全局状态，DI 在 otter-buddy 这种规模下开销大于收益。
// registry 通过 initMetrics(logger, options) 显式初始化，测试可调用 resetMetricsRegistry()。
let globalRegistry: MetricsRegistry | undefined;

export function initMetricsRegistry(logger: Logger, options?: MetricsOptions): MetricsRegistry {
  if (globalRegistry) {
    logger.warn("MetricsRegistry already initialized, reusing existing instance");
    return globalRegistry;
  }
  globalRegistry = new MetricsRegistry(logger, options);
  globalRegistry.start();
  return globalRegistry;
}

export function getMetricsRegistry(): MetricsRegistry | undefined {
  return globalRegistry;
}

/** 仅供测试使用：重置全局单例 + dispose */
export async function resetMetricsRegistry(): Promise<void> {
  if (globalRegistry) {
    await globalRegistry.dispose();
    globalRegistry = undefined;
  }
}

// ── 高精度计时工具 ──
export function nowMs(): number {
  return performance.now();
}
