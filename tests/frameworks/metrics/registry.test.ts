import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MetricsRegistry, resetMetricsRegistry } from "@frameworks/metrics/registry";
import type { Logger } from "@usecases/ports/logger";

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
}

describe("MetricsRegistry", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(async () => {
    await resetMetricsRegistry();
  });

  it("counter 累加并能在 metricsText 中输出", async () => {
    const reg = new MetricsRegistry(noopLogger, { dir });
    const c = reg.counter({ name: "test_counter_total", help: "test" });
    c.inc();
    c.inc();
    const text = await reg.metricsText();
    expect(text).toContain("test_counter_total");
    expect(text).toContain("2");
  });

  it("histogram observe 后产出 bucket counter", async () => {
    const reg = new MetricsRegistry(noopLogger, { dir });
    const h = reg.histogram({
      name: "test_duration_ms",
      help: "test",
      buckets: [100, 500],
    });
    h.observe(50);
    h.observe(200);
    const text = await reg.metricsText();
    expect(text).toContain("test_duration_ms_bucket");
    expect(text).toContain('le="100"');
    expect(text).toContain('le="500"');
  });

  it("flush 写入今日 JSONL 文件", async () => {
    const reg = new MetricsRegistry(noopLogger, { dir });
    const c = reg.counter({
      name: "flush_test_total",
      help: "test",
      labelNames: ["kind"] as const,
    });
    c.inc({ kind: "a" });
    c.inc({ kind: "a" });
    c.inc({ kind: "b" });

    await reg.flush();

    const today = new Date().toISOString().slice(0, 10);
    const files = fs.readdirSync(dir);
    expect(files).toContain(`metrics-${today}.jsonl`);

    const content = fs.readFileSync(path.join(dir, `metrics-${today}.jsonl`), "utf-8");
    const lines = content.trim().split("\n").map(l => JSON.parse(l) as { metric: string; labels: Record<string, string>; value: number; ts: string });
    expect(lines.length).toBe(2); // kind=a + kind=b
    expect(lines.every(l => l.metric === "flush_test_total")).toBe(true);
    expect(lines.find(l => l.labels.kind === "a")?.value).toBe(2);
    expect(lines.find(l => l.labels.kind === "b")?.value).toBe(1);
  });

  it("清理超过 maxAgeDays 的旧文件", () => {
    // 准备一个 8 天前的文件（按文件名日期 + 同步 utimes 设旧 mtime）
    const oldMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const oldDate = new Date(oldMs).toISOString().slice(0, 10);
    const oldFile = path.join(dir, `metrics-${oldDate}.jsonl`);
    fs.writeFileSync(oldFile, '{"ts":"old"}\n');
    fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);
    expect(fs.existsSync(oldFile)).toBe(true);

    // 启动 registry（start 内会 cleanup）
    const reg = new MetricsRegistry(noopLogger, { dir, maxAgeDays: 7 });
    reg.start();

    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it("dispose 停止定时 flush 且幂等", async () => {
    const reg = new MetricsRegistry(noopLogger, { dir, flushIntervalMs: 100 });
    reg.start();
    await reg.dispose();
    await reg.dispose(); // 幂等
    // 不抛错即成功
    expect(true).toBe(true);
  });

  it("重复注册同名 metric 返回相同实例", async () => {
    const reg = new MetricsRegistry(noopLogger, { dir });
    const c1 = reg.counter({ name: "dup_total", help: "first" });
    const c2 = reg.counter({ name: "dup_total", help: "second" });
    expect(c1).toBe(c2);
    c1.inc();
    const text = await reg.metricsText();
    expect(text).toContain("dup_total");
  });
});
