import type {
  EmbeddingGateway,
  EmbeddingHealthSnapshot,
  EmbeddingQueueStats,
  EmbeddingServiceStats,
} from "./embedding-gateway";
import type { MemoryQueue } from "./memory-queue";

const UNREADY_ALERT_MS = 60_000;
const ETA_ALERT_SECONDS = 4 * 60 * 60;

export async function readEmbeddingHealth(
  gateways: Partial<Record<"query" | "live" | "backfill", EmbeddingGateway>>,
  queue: MemoryQueue,
  now: number = Date.now(),
): Promise<EmbeddingHealthSnapshot> {
  const lanes: EmbeddingHealthSnapshot["lanes"] = {};
  for (const [name, gateway] of Object.entries(gateways) as Array<["query" | "live" | "backfill", EmbeddingGateway]>) {
    if (gateway.stats) lanes[name] = gateway.stats;
  }
  const queueStats = await readQueueStats(queue, lanes.backfill);
  const alerts = collectAlerts(lanes, queueStats, now);
  return { lanes, queue: queueStats, alerts };
}

async function readQueueStats(
  queue: MemoryQueue,
  backfill: EmbeddingServiceStats | undefined,
): Promise<EmbeddingQueueStats | null> {
  if (typeof queue.pendingTaskStats !== "function") return null;
  const stats = await queue.pendingTaskStats();
  const hasThroughput = backfill && backfill.tokensPerSec > 0 && backfill.meanTokensPerText > 0;
  const etaSeconds = hasThroughput
    ? Math.round(stats.pending * backfill.meanTokensPerText / backfill.tokensPerSec)
    : null;
  return {
    pending: stats.pending,
    oldestAgeSeconds: stats.oldestAgeSeconds,
    ageP50Seconds: stats.ageP50Seconds,
    ageP95Seconds: stats.ageP95Seconds,
    etaSeconds,
    byPriority: stats.byPriority,
  };
}

function collectAlerts(
  lanes: EmbeddingHealthSnapshot["lanes"],
  queue: EmbeddingQueueStats | null,
  now: number,
): string[] {
  const alerts: string[] = [];
  if ((lanes.live?.pendingWaiters ?? 0) > 10) {
    alerts.push(`live waiter depth ${lanes.live!.pendingWaiters} > 10`);
  }
  for (const [name, lane] of Object.entries(lanes)) {
    if (lane.unreadySince !== null && now - lane.unreadySince > UNREADY_ALERT_MS) {
      alerts.push(`${name} lane unready for ${Math.floor((now - lane.unreadySince) / 1000)}s`);
    }
  }
  if ((queue?.etaSeconds ?? 0) > ETA_ALERT_SECONDS) {
    alerts.push(`backfill ETA ${queue!.etaSeconds}s > ${ETA_ALERT_SECONDS}s`);
  }
  return alerts;
}
