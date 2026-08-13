/**
 * F20260813mrel Part 3: 删除关系边（unlink_memory 工具用）。
 * 纠错场景：LLM 发现之前声明的边有误，删除重建。
 */
import type { MemoryRepository } from "./memory-repository";
import { DomainError } from "@entities/errors";

export class DeleteEdge {
  constructor(private readonly repo: MemoryRepository) {}

  async execute(edgeId: string): Promise<void> {
    const edge = await this.repo.getEdgeById(edgeId);
    if (!edge) {
      throw new DomainError(`edge not found: ${edgeId}`, "not_found");
    }
    await this.repo.deleteEdge(edgeId);
  }
}
