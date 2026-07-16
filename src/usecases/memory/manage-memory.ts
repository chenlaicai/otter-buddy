import type { MemoryEntry, MemoryWeight } from "@entities/memory/memory-entry";
import type { MemoryRepository } from "./memory-repository";

export class ManageMemory {
  constructor(private readonly repo: MemoryRepository) {}

  async getById(id: string): Promise<MemoryEntry | null> {
    return this.repo.getById(id);
  }

  /** 按 ID 批量获取完整记忆条目（渐进式披露 get_memory_detail） */
  async getDetails(ids: string[]): Promise<MemoryEntry[]> {
    return this.repo.getDetails(ids);
  }

  async getBySource(
    sourceTable: string,
    sourceId: string,
  ): Promise<MemoryEntry | null> {
    return this.repo.getBySource(sourceTable, sourceId);
  }

  async getWeight(memoryEntryId: string): Promise<MemoryWeight> {
    const weights = await this.repo.getWeights([memoryEntryId]);
    if (weights.length === 0) {
      return {
        memoryEntryId,
        retrievalCount: 0,
        lastRetrievedAt: null,
        userFlagged: false,
      };
    }
    return weights[0];
  }

  async flagMemory(memoryEntryId: string, flagged: boolean): Promise<void> {
    await this.repo.flagMemory(memoryEntryId, flagged);
  }
}
