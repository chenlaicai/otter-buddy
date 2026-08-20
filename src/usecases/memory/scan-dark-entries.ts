/**
 * F20260811mrpy Part 1 + F20260812mrcq Part 1：扫描无 vec 索引的暗化条目。
 *
 * store-memory.ts 的 embedding 存储是 fire-and-forget，失败后入 embedding_tasks 队列。
 * 本用例暴露"FTS 可搜 / Vec 不可搜"的条目供运维排查。
 *
 * F20260812mrcq Part 1：
 * - 默认排除 status='dead' 的 dead-letter（防报告噪音）
 * - 传 includeDead=true 查看全部（运维主动排查）
 */
import type { MemoryReader } from "./memory-reader";
import type { DarkEntry } from "./memory-types";
import type { Logger } from "@usecases/ports/logger";

export interface ScanDarkEntriesResult {
  entries: DarkEntry[];
  total: number;
  vecDisabled: boolean;
}

export class ScanDarkEntries {
  constructor(
    private readonly reader: MemoryReader,
    private readonly logger?: Logger,
  ) {}

  async execute(includeDead: boolean = false): Promise<ScanDarkEntriesResult> {
    const result = await this.reader.scanDarkEntries(includeDead);
    if (result.total > 0) {
      this.logger?.warn(`Detected ${result.total} dark entries (no vec index)`);
    }
    return result;
  }
}
