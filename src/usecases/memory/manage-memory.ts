import type { MemoryEntry, MemoryLayer } from "@entities/memory/memory-entry";
import { canTransitionMemoryLayer } from "@entities/memory/memory-entry";
import { DomainError } from "@entities/errors";
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

  async flagMemory(memoryEntryId: string, flagged: boolean): Promise<void> {
    await this.repo.flagMemory(memoryEntryId, flagged);
  }

  async updateLayer(
    conversationId: string,
    from: MemoryLayer,
    to: MemoryLayer,
  ): Promise<void> {
    if (!canTransitionMemoryLayer(from, to)) {
      throw new DomainError(
        `Invalid memory layer transition: ${from} -> ${to}`,
        "validation",
      );
    }
    await this.repo.updateLayerByConversation(conversationId, from, to);
  }
}
