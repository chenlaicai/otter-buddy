import type { ScheduleType } from '@entities/scheduled-task/scheduled-task';

/**
 * Scheduler 指标端口（F20260814qswp）。
 *
 * usecases 层此前直接 import frameworks/metrics 的具体类型与 nowMs 值，
 * 是分层边界的实际破口（eslint 白名单遗漏 metrics 所致）。
 * 端口按 usecase 实际用到的方法收窄；frameworks 的 SchedulerMetrics
 * 结构化兼容，无需 adapter。now 时钟同样注入化。
 */
export interface SchedulerMetricsPort {
  recordTrigger(type: ScheduleType, status: 'completed' | 'failed' | 'skipped'): void;
  observeExecutionDuration(type: ScheduleType, durationMs: number): void;
  recordRetry(type: ScheduleType): void;
  recordExpired(): void;
  setActiveTasks(type: ScheduleType, count: number): void;
}
