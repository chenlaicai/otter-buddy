import type { MemoryEntry, MemoryWeight, MemoryLayer } from "@entities/memory/memory-entry";
import { canTransitionMemoryLayer } from "@entities/memory/memory-entry";
import type { MemoryRepository } from "./memory-repository";

export class ManageMemory {
  constructor(private readonly repo: MemoryRepository) {}

  async getById(id: string): Promise<MemoryEntry | null> {
    return this.repo.getById(id);
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

  async updateLayer(
    conversationId: string,
    from: MemoryLayer,
    to: MemoryLayer,
  ): Promise<void> {
    /** 不变量校验：确保层转换合法 */
    if (!canTransitionMemoryLayer(from, to)) {
      throw new Error(
        `Invalid memory layer transition: ${from} -> ${to}`,
      );
    }
    await this.repo.updateLayerByConversation(conversationId, from, to);
  }
}
