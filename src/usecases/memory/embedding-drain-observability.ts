import type { EmbeddingServiceStats } from "./embedding-gateway";

export interface DrainQueueStats {
  pending: number;
  oldestAgeSeconds: number | null;
  ageP50Seconds: number | null;
  ageP95Seconds: number | null;
  byPriority: Record<number, number>;
  earliestNextRetryAt?: string | null;
}

export function queueDrainFields(stats: DrainQueueStats | null): Record<string, unknown> {
  if (!stats) {
    return {
      pending: -1,
      oldestPendingAgeSeconds: null,
      pendingAgeP50Seconds: null,
      pendingAgeP95Seconds: null,
      pendingByPriority: {},
    };
  }
  return {
    pending: stats.pending,
    oldestPendingAgeSeconds: stats.oldestAgeSeconds,
    pendingAgeP50Seconds: stats.ageP50Seconds,
    pendingAgeP95Seconds: stats.ageP95Seconds,
    pendingByPriority: stats.byPriority,
  };
}

export function laneDrainFields(stats: EmbeddingServiceStats | undefined): Record<string, unknown> {
  if (!stats) {
    return {
      lane: null, laneState: null, laneAttempts: null, tokensPerSec: null,
      perTextLatencyMs: null, ramInFlight: null, ramPendingWaiters: null,
    };
  }
  return {
    lane: stats.lane,
    laneState: stats.state,
    laneAttempts: stats.attempts,
    tokensPerSec: stats.tokensPerSec,
    perTextLatencyMs: stats.perTextLatencyMs,
    ramInFlight: stats.inFlight,
    ramPendingWaiters: stats.pendingWaiters,
  };
}
