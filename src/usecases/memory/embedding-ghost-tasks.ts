import type { Logger } from "@usecases/ports/logger";
import type { EmbeddingTask, MemoryQueue } from "./memory-queue";

/** entry 已删的任务无法计算，逐条记账转 dead；健康任务保持原顺序。 */
export async function separateGhostEmbeddingTasks(
  claimed: EmbeddingTask[],
  queue: MemoryQueue,
  logger: Logger,
  maxAttempts: number,
): Promise<{ actionable: EmbeddingTask[]; ghostFailures: number }> {
  const actionable: EmbeddingTask[] = [];
  let ghostFailures = 0;
  for (const task of claimed) {
    if (!task.content) {
      logger.warn(`EmbeddingRetryWorker: entry ${task.entryId} vanished, recording failed attempt`);
      await queue.markTaskAttemptFailed(task.entryId, new Error("entry deleted"), maxAttempts);
      ghostFailures++;
      continue;
    }
    actionable.push(task);
  }
  return { actionable, ghostFailures };
}
