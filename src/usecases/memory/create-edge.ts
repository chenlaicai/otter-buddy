/**
 * F20260813mren Part 1: 创建记忆关系边。
 *
 * D3: 校验 from/to entry 都是 coarse 粒度——防 chunk sync 时 replaceEntriesBySource
 *     删旧建新 chunk 导致 CASCADE/手动删边静默丢失。
 * D7: 幂等由 repo 层 UNIQUE(from, to, type) + ON CONFLICT 保证。
 */
import type { EdgeType } from "@entities/memory/memory-edge";
import type { MemoryRepository } from "./memory-repository";
import type { Logger } from "@usecases/ports/logger";
import { DomainError } from "@entities/errors";

export interface CreateEdgeInput {
  fromEntryId: string;
  toEntryId: string;
  edgeType: EdgeType;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}

export class CreateEdge {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly logger: Logger,
  ) {}

  async execute(input: CreateEdgeInput): Promise<string> {
    // 自环检查（DB 也有 CHECK 约束，这里提前给出清晰错误）
    if (input.fromEntryId === input.toEntryId) {
      throw new DomainError("self-loop edges not allowed", "validation");
    }

    // D3: 校验两端 entry 不是 chunk 类型（chunk 被 sync replaceEntriesBySource 删旧建新，边会静默丢失）
    // 注意：message 是 fine 粒度但不会被 sync 替换，所以允许建边。
    // 真正需要排除的只有 feature_chunk 和 research_chunk。
    const [fromEntry, toEntry] = await Promise.all([
      this.repo.getById(input.fromEntryId),
      this.repo.getById(input.toEntryId),
    ]);
    if (!fromEntry) {
      throw new DomainError(`entry not found: ${input.fromEntryId}`, "not_found");
    }
    if (!toEntry) {
      throw new DomainError(`entry not found: ${input.toEntryId}`, "not_found");
    }
    const CHUNK_TYPES = ["feature_chunk", "research_chunk"];
    if (CHUNK_TYPES.includes(fromEntry.contentType)) {
      throw new DomainError(
        `edges not allowed on chunk entries (D3: sync replaceEntriesBySource would silently lose them). from entry ${input.fromEntryId} is ${fromEntry.contentType}`,
        "validation",
      );
    }
    if (CHUNK_TYPES.includes(toEntry.contentType)) {
      throw new DomainError(
        `edges not allowed on chunk entries (D3). to entry ${input.toEntryId} is ${toEntry.contentType}`,
        "validation",
      );
    }

    const edgeId = await this.repo.createEdge(input);
    this.logger.debug(`Created edge ${edgeId}: ${input.fromEntryId} -[${input.edgeType}]-> ${input.toEntryId}`);
    return edgeId;
  }
}
