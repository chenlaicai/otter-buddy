import type { Logger } from "@usecases/ports/logger";
import type { EntryProjectionInput } from "./entry-projection-policy";
import { decideEntryProjection } from "./entry-projection-policy";
import type { EntryMemoryProjector, EntryProjectionApplyResult } from "./entry-memory-projector";

export interface ProjectionOutboxTask {
  entryId: string;
  conversationId: string;
  attachmentIntentIds: string[];
  attempts: number;
  createdAt: string;
}

export interface EntryProjectionOutbox {
  claimDue(nowIso: string, limit: number): ProjectionOutboxTask[];
  markDone(entryId: string, nowIso: string): void;
  markSkipped(entryId: string, nowIso: string, reason?: string): void;
  markFailed(entryId: string, error: string, now: Date, maxAttempts: number): void;
}

export type StoredEntryProjectionInput = EntryProjectionInput & { createdAt: string };

interface EntryProjectionWorkerDeps {
  outbox: EntryProjectionOutbox;
  readSource: (task: ProjectionOutboxTask) => StoredEntryProjectionInput | null;
  projector: EntryMemoryProjector;
  onProjected: (result: Extract<EntryProjectionApplyResult, { kind: "projected" }>) => void;
  logger: Logger;
  now?: () => Date;
  maxAttempts?: number;
  batchSize?: number;
  /** 故障注入位于持久 apply 与终态记账之间，验证重放不重复投影。 */
  afterApply?: (result: EntryProjectionApplyResult) => void;
}

export class EntryProjectionWorker {
  private draining: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly batchSize: number;

  constructor(private readonly deps: EntryProjectionWorkerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.batchSize = deps.batchSize ?? 100;
  }

  async tickNow(): Promise<void> {
    if (this.stopped) return;
    if (this.draining) return this.draining;
    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.draining;
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const tasks = this.deps.outbox.claimDue(this.now().toISOString(), this.batchSize);
      if (tasks.length === 0) return;
      for (const task of tasks) {
        this.applyTask(task);
        // Why: SQLite writes are synchronous; yielding keeps health and message I/O responsive during backlog recovery.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  private applyTask(task: ProjectionOutboxTask): void {
    try {
      const input = this.deps.readSource(task);
      const result = input
        ? this.deps.projector.apply(decideEntryProjection(input), input.createdAt)
        : { kind: "skipped" as const, reason: "empty" as const };
      if (result.kind === "projected") this.deps.onProjected(result);
      this.deps.afterApply?.(result);
      if (result.kind === "skipped") {
        this.deps.outbox.markSkipped(task.entryId, this.now().toISOString(), input ? undefined : "source entry missing");
      }
      else this.deps.outbox.markDone(task.entryId, this.now().toISOString());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.outbox.markFailed(task.entryId, message, this.now(), this.maxAttempts);
      this.deps.logger.warn("Entry projection delivery failed", {
        entryId: task.entryId,
        conversationId: task.conversationId,
        error: message,
      });
    }
  }
}
