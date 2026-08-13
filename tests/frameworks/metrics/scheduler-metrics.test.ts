import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MetricsRegistry, resetMetricsRegistry } from "@frameworks/metrics/registry";
import { SchedulerMetrics } from "@frameworks/metrics/scheduler-metrics";
import type { Logger } from "@usecases/ports/logger";

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

describe("SchedulerMetrics", () => {
  let dir: string;
  let registry: MetricsRegistry;
  let metrics: SchedulerMetrics;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-metrics-test-"));
    registry = new MetricsRegistry(noopLogger, { dir });
    metrics = new SchedulerMetrics(registry);
  });

  afterEach(async () => {
    await resetMetricsRegistry();
  });

  it("recordTrigger 递增 type+status 标签 counter", async () => {
    metrics.recordTrigger("once", "completed");
    metrics.recordTrigger("once", "completed");
    metrics.recordTrigger("cron", "failed");
    const text = await registry.metricsText();
    expect(text).toContain('scheduler_trigger_total{type="once",status="completed"} 2');
    expect(text).toContain('scheduler_trigger_total{type="cron",status="failed"} 1');
  });

  it("observeExecutionDuration 产出 histogram bucket", async () => {
    metrics.observeExecutionDuration("once", 50);
    metrics.observeExecutionDuration("once", 5000);
    const text = await registry.metricsText();
    expect(text).toContain('scheduler_execution_duration_ms_bucket{le="100",type="once"}');
    expect(text).toContain('scheduler_execution_duration_ms_bucket{le="5000",type="once"}');
  });

  it("recordRetry 递增 retry counter", async () => {
    metrics.recordRetry("once");
    metrics.recordRetry("once");
    const text = await registry.metricsText();
    expect(text).toContain('scheduler_retry_total{type="once"} 2');
  });

  it("recordExpired 递增无标签 counter", async () => {
    metrics.recordExpired();
    const text = await registry.metricsText();
    expect(text).toMatch(/scheduler_expired_total\s+1/);
  });

  it("setActiveTasks 设置 gauge 当前值", async () => {
    metrics.setActiveTasks("cron", 5);
    metrics.setActiveTasks("once", 2);
    const text = await registry.metricsText();
    expect(text).toContain('scheduler_active_tasks{type="cron"} 5');
    expect(text).toContain('scheduler_active_tasks{type="once"} 2');
  });
});
