/**
 * F20260811mrpy Part 1：扫描无 vec 索引的暗化条目。
 *
 * store-memory.ts 的 embedding 存储是 fire-and-forget，失败后无补偿。
 * 失败条目永久"FTS 可搜 / Vec 不可搜"，本用例暴露这些条目供运维或后续修复链路消费。
 *
 * 注意：本用例只做检测，不做补 embed。补 embed 的修复链路留 P2-3 Embedding Re-embed 基础设施。
 */
import type { MemoryRepository, DarkEntry } from "./memory-repository";
import type { Logger } from "@usecases/ports/logger";

export interface ScanDarkEntriesResult {
  entries: DarkEntry[];
  total: number;
  vecDisabled: boolean;
}

export class ScanDarkEntries {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly logger?: Logger,
  ) {}

  async execute(): Promise<ScanDarkEntriesResult> {
    const result = await this.repo.scanDarkEntries();
    if (result.total > 0) {
      this.logger?.warn(`Detected ${result.total} dark entries (no vec index)`);
    }
    return result;
  }
}
