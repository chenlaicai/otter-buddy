/**
 * F20260813mren Part 3: 删除关系边（unlink_memory 工具用）。
 * 纠错场景：LLM 发现之前声明的边有误，删除重建。
 * 幂等：删不存在的 edge_id 静默返回（与工具描述一致）。
 */
import type { MemoryRepository } from "./memory-repository";

export class DeleteEdge {
  constructor(private readonly repo: MemoryRepository) {}

  async execute(edgeId: string): Promise<void> {
    // 幂等：边不存在时静默返回，不抛错（工具描述说"删不存在的 edge_id 不报错"）
    await this.repo.deleteEdge(edgeId);
  }
}
