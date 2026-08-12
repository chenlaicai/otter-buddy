/**
 * Scheduler 模块的 metric 定义
 *
 * 注册的指标：
 * - scheduler_trigger_total{type, status}      counter  触发总次数（成功/失败）
 * - scheduler_execution_duration_ms{type}      histogram  单次执行耗时
 * - scheduler_retry_total{type}                counter  once 任务重试次数
 * - scheduler_expired_total                    counter  once 任务过期 disabled
 * - scheduler_active_tasks{type}               gauge    当前 active 任务数
 *
 * 标签 type 取值：cron | once
 */
import type { Counter, Histogram, Gauge } from "prom-client";
import type { MetricsRegistry } from "./registry";
import type { ScheduleType } from "@entities/scheduled-task/scheduled-task";

const TRIGGER_LABELS = ["type", "status"] as const;
const TYPE_LABELS = ["type"] as const;

export class SchedulerMetrics {
  private readonly triggerTotal: Counter<typeof TRIGGER_LABELS[number]>;
  private readonly executionDuration: Histogram<typeof TYPE_LABELS[number]>;
  private readonly retryTotal: Counter<typeof TYPE_LABELS[number]>;
  private readonly expiredTotal: Counter<string>;
  private readonly activeTasks: Gauge<typeof TYPE_LABELS[number]>;

  constructor(private readonly registry: MetricsRegistry) {
    this.triggerTotal = registry.counter({
      name: "scheduler_trigger_total",
      help: "Total scheduled task triggers by type and outcome",
      labelNames: TRIGGER_LABELS,
    });
    this.executionDuration = registry.histogram({
      name: "scheduler_execution_duration_ms",
      help: "Scheduled task execution duration in milliseconds",
      labelNames: TYPE_LABELS,
      buckets: [100, 500, 1000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000],
    });
    this.retryTotal = registry.counter({
      name: "scheduler_retry_total",
      help: "Total once-task retry attempts",
      labelNames: TYPE_LABELS,
    });
    this.expiredTotal = registry.counter({
      name: "scheduler_expired_total",
      help: "Once tasks that were already past triggerAt when scheduled",
    });
    this.activeTasks = registry.gauge({
      name: "scheduler_active_tasks",
      help: "Currently active scheduled tasks",
      labelNames: TYPE_LABELS,
    });
  }

  recordTrigger(type: ScheduleType, status: "completed" | "failed" | "skipped"): void {
    this.triggerTotal.inc({ type, status });
  }

  observeExecutionDuration(type: ScheduleType, durationMs: number): void {
    this.executionDuration.observe({ type }, durationMs);
  }

  recordRetry(type: ScheduleType): void {
    this.retryTotal.inc({ type });
  }

  recordExpired(): void {
    this.expiredTotal.inc();
  }

  setActiveTasks(type: ScheduleType, count: number): void {
    this.activeTasks.set({ type }, count);
  }
}
