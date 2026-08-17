import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MetricsRegistry, resetMetricsRegistry } from "@frameworks/metrics/registry";
import { AgentMetrics } from "@frameworks/metrics/agent-metrics";
import type { Logger } from "@usecases/ports/logger";
import { toRetryLabel } from "@usecases/ports/agent-metrics-port";

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

describe("AgentMetrics", () => {
  let dir: string;
  let registry: MetricsRegistry;
  let metrics: AgentMetrics;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-metrics-test-"));
    registry = new MetricsRegistry(noopLogger, { dir });
    metrics = new AgentMetrics(registry);
  });

  afterEach(async () => {
    await resetMetricsRegistry();
  });

  it("recordInvoke 递增全 label counter + duration histogram", async () => {
    metrics.recordInvoke({
      otterId: "otter-1", model: "mimo", otterType: "big", source: "chain",
      outcome: "success", retry: "0", durationMs: 1200,
    });
    metrics.recordInvoke({
      otterId: "otter-1", model: "mimo", otterType: "big", source: "chain",
      outcome: "success", retry: "0", durationMs: 2500,
    });
    metrics.recordInvoke({
      otterId: "otter-2", model: "default", otterType: "small", source: "direct",
      outcome: "no_speak_failed", retry: "manual", durationMs: 800,
    });
    const text = await registry.metricsText();
    expect(text).toContain('agent_invoke_total{model="mimo",otter_type="big",source="chain",outcome="success",retry="0"} 2');
    expect(text).toContain('agent_invoke_total{model="default",otter_type="small",source="direct",outcome="no_speak_failed",retry="manual"} 1');
    expect(text).toContain('agent_invoke_duration_ms_bucket{le="5000"');
  });

  it("token 按 otterId 差分为 attempt 增量（session 累计值不虚增）", async () => {
    // 第一次 attempt：session 累计 1000/200 → 增量 1000/200
    metrics.recordInvoke({
      otterId: "otter-1", model: "mimo", otterType: "big", source: "chain",
      outcome: "success", retry: "0", durationMs: 100,
      tokenUsage: { input: 1000, output: 200 },
    });
    // 第二次 attempt：session 累计 1500/300 → 增量 500/100
    metrics.recordInvoke({
      otterId: "otter-1", model: "mimo", otterType: "big", source: "chain",
      outcome: "success", retry: "0", durationMs: 100,
      tokenUsage: { input: 1500, output: 300 },
    });
    const text = await registry.metricsText();
    expect(text).toContain('agent_token_input_total{model="mimo",otter_type="big"} 1500');
    expect(text).toContain('agent_token_output_total{model="mimo",otter_type="big"} 300');
  });

  it("session 重置后累计值回落 → 取全量（不记负数）", async () => {
    metrics.recordInvoke({
      otterId: "otter-1", model: "mimo", otterType: "big", source: "chain",
      outcome: "success", retry: "0", durationMs: 100,
      tokenUsage: { input: 1500, output: 300 },
    });
    // session 重置：累计回落到 100
    metrics.recordInvoke({
      otterId: "otter-1", model: "mimo", otterType: "big", source: "chain",
      outcome: "success", retry: "0", durationMs: 100,
      tokenUsage: { input: 100, output: 20 },
    });
    const text = await registry.metricsText();
    expect(text).toContain('agent_token_input_total{model="mimo",otter_type="big"} 1600');
    expect(text).toContain('agent_token_output_total{model="mimo",otter_type="big"} 320');
  });

  it("ctxTokens / firstByteLatency 有观测值", async () => {
    metrics.recordInvoke({
      otterId: "otter-1", model: "mimo", otterType: "big", source: "chain",
      outcome: "success", retry: "0", durationMs: 100,
      ctxTokens: 80_000, firstByteLatencyMs: 800,
    });
    const text = await registry.metricsText();
    expect(text).toContain('agent_context_tokens_bucket{le="100000"');
    expect(text).toContain('agent_first_byte_latency_ms_bucket{le="1000"');
  });

  it("recordGuardAbort 归一化 reason（circuit_break:* → circuit_break，未知 → other）", async () => {
    metrics.recordGuardAbort("mimo", "circuit_break:event_timeout");
    metrics.recordGuardAbort("mimo", "degenerate_output");
    metrics.recordGuardAbort("mimo", "some_new_reason");
    const text = await registry.metricsText();
    expect(text).toContain('agent_guard_abort_total{model="mimo",reason="circuit_break"} 1');
    expect(text).toContain('agent_guard_abort_total{model="mimo",reason="degenerate_output"} 1');
    expect(text).toContain('agent_guard_abort_total{model="mimo",reason="other"} 1');
  });

  it("工具与链路指标递增", async () => {
    metrics.recordToolCall("speak");
    metrics.recordToolDuration("speak", 150);
    metrics.recordToolError("bash");
    metrics.recordRetry("sdk_auto");
    metrics.recordRetry("no_speak");
    metrics.recordCompaction("token_limit", false);
    metrics.recordSessionRebuild();
    metrics.recordChainHops(3);
    metrics.recordChainDepthExceeded();
    const text = await registry.metricsText();
    expect(text).toContain('agent_tool_calls_total{tool="speak"} 1');
    expect(text).toContain('agent_tool_duration_ms_bucket{le="500",tool="speak"}');
    expect(text).toContain('agent_tool_errors_total{tool="bash"} 1');
    expect(text).toContain('agent_retry_total{kind="sdk_auto"} 1');
    expect(text).toContain('agent_retry_total{kind="no_speak"} 1');
    expect(text).toContain('agent_compaction_total{reason="token_limit",aborted="false"} 1');
    expect(text).toMatch(/agent_session_rebuild_total\s+1/);
    expect(text).toContain('agent_chain_hops_bucket{le="3"}');
    expect(text).toMatch(/agent_chain_depth_exceeded_total\s+1/);
  });

  it("toRetryLabel 封闭枚举映射", () => {
    expect(toRetryLabel(0, false)).toBe("0");
    expect(toRetryLabel(1, false)).toBe("auto");
    expect(toRetryLabel(1, true)).toBe("manual");
  });
});
