import type {
  EmbeddingLaneName,
  EmbeddingLaneState,
  EmbeddingLatencyStats,
} from "@usecases/memory/embedding-gateway";

const LATENCY_CAPACITY = 128;
const EWMA_ALPHA = 0.2;

/** Why: 分位数输入有界——health 是高频读路径，不能让观测面自身保留全部生产语料耗时。 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

/** 单 lane 的进程内指标；只保存 128 个延迟样本与 EWMA，不保存文本或向量。 */
export class LaneMetrics {
  private readonly latencies: number[] = [];
  private tokensPerSecValue = 0;
  private meanTokensValue = 0;
  private samples = 0;

  record(durationMs: number, tokens: number): void {
    const safeDuration = Math.max(1, durationMs);
    this.latencies.push(safeDuration);
    if (this.latencies.length > LATENCY_CAPACITY) this.latencies.shift();
    const throughput = Math.max(0, tokens) / (safeDuration / 1000);
    this.tokensPerSecValue = this.samples === 0
      ? throughput
      : EWMA_ALPHA * throughput + (1 - EWMA_ALPHA) * this.tokensPerSecValue;
    this.meanTokensValue = this.samples === 0
      ? tokens
      : EWMA_ALPHA * tokens + (1 - EWMA_ALPHA) * this.meanTokensValue;
    this.samples++;
  }

  latency(): EmbeddingLatencyStats {
    return {
      p50: percentile(this.latencies, 0.5),
      p95: percentile(this.latencies, 0.95),
      p99: percentile(this.latencies, 0.99),
      samples: this.latencies.length,
    };
  }

  tokensPerSec(): number {
    return Math.round(this.tokensPerSecValue * 100) / 100;
  }

  meanTokens(): number {
    return this.meanTokensValue;
  }
}

export function laneState(input: {
  ready: boolean;
  circuitBroken: boolean;
  inFlight: number;
}): EmbeddingLaneState {
  if (input.circuitBroken) return "dead";
  if (!input.ready) return "unready";
  return input.inFlight > 0 ? "busy" : "ready";
}

export function emptyLaneStats(lane: EmbeddingLaneName): {
  lane: EmbeddingLaneName;
  state: EmbeddingLaneState;
  inFlight: number;
  pendingWaiters: number;
  attempts: number;
  lastProgressAt: number | null;
  unreadySince: number | null;
  circuitBroken: boolean;
  tokensPerSec: number;
  meanTokensPerText: number;
  perTextLatencyMs: EmbeddingLatencyStats;
} {
  return {
    lane,
    state: "spawning",
    inFlight: 0,
    pendingWaiters: 0,
    attempts: 0,
    lastProgressAt: null,
    unreadySince: null,
    circuitBroken: false,
    tokensPerSec: 0,
    meanTokensPerText: 0,
    perTextLatencyMs: { p50: null, p95: null, p99: null, samples: 0 },
  };
}
