/**
 * F20260813mrel Part 1: 从某 entry 出发 BFS 遍历关系图。
 *
 * D4: relates-to 自动双向（查询层处理），其余按 direction。
 * D6: 返回结构化 path [{entry, edgeType, edgeFromEntryId, depth}]——LLM 能拼链而非看散点。
 * 环安全：visited set 守门。
 *
 * 注：provenance messages（Part 2.3）在工具层组合，不在本 use case。
 */
import type { EdgeType, RelatedEntryItem } from "@entities/memory/memory-edge";
import type { MemoryRepository } from "./memory-repository";

export interface GetRelatedInput {
  entryId: string;
  /** BFS 深度，默认 1 */
  depth?: number;
  /** 过滤边类型 */
  edgeTypes?: EdgeType[];
  /** 方向：out=出边（默认），in=入边 */
  direction?: "out" | "in";
  /** 最大结果数 */
  limit?: number;
}

const DEFAULT_DEPTH = 1;
const DEFAULT_LIMIT = 20;

export class GetRelated {
  constructor(private readonly repo: MemoryRepository) {}

  async execute(input: GetRelatedInput): Promise<RelatedEntryItem[]> {
    const maxDepth = input.depth ?? DEFAULT_DEPTH;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const direction = input.direction ?? "out";

    const results: RelatedEntryItem[] = [];
    const visited = new Set<string>([input.entryId]); // 防环

    // BFS frontier: 当前层的 entry ids
    let frontier: Array<{ entryId: string; depth: number }> = [{ entryId: input.entryId, depth: 0 }];

    for (let d = 1; d <= maxDepth && results.length < limit; d++) {
      const nextFrontier: Array<{ entryId: string; depth: number }> = [];

      for (const node of frontier) {
        if (results.length >= limit) break;

        const neighbors = await this.repo.getEdgesByEntry(node.entryId, {
          edgeTypes: input.edgeTypes,
          direction,
        });

        for (const { edge, neighborEntry } of neighbors) {
          if (visited.has(neighborEntry.id)) continue;
          visited.add(neighborEntry.id);

          results.push({
            entry: neighborEntry,
            edgeType: edge.edgeType,
            edgeFromEntryId: edge.fromEntryId,
            depth: d,
          });

          nextFrontier.push({ entryId: neighborEntry.id, depth: d });

          if (results.length >= limit) break;
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return results;
  }
}
