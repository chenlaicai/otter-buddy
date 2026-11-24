import type { MemoryEntry } from "@entities/memory/memory-entry";
import type { ProjectionDecision } from "./entry-projection-policy";
import type { EmbeddingGeneration } from "./memory-types";

/** SQLite 同步投影写入端口；增量与离线迁移/清理共用一个 projector。 */
export interface EntryProjectionStore {
  /** 按源 entry.id 幂等 upsert 主表与 FTS/weights；同内容重放返回 false，不触发新 embedding。 */
  upsertEntryProjection(entry: MemoryEntry): { contentChanged: boolean } & EmbeddingGeneration;
  /** 显式运维清理专用：主表、FTS、vec、weights、tasks、关系边联动删除。 */
  deleteEntryProjection(entryId: string): void;
}

export type EntryProjectionApplyResult =
  | { kind: "skipped"; reason: "external" | "unsupported-type" | "empty" }
  | { kind: "unchanged"; entryId: string }
  | ({ kind: "projected"; entryId: string; content: string } & EmbeddingGeneration);

/** 直接路径、老库回填和未来 outbox worker 的共同应用入口。 */
export class EntryMemoryProjector {
  constructor(private readonly store: EntryProjectionStore) {}

  apply(decision: ProjectionDecision, createdAt: string): EntryProjectionApplyResult {
    if (decision.kind === "skip") {
      // 启动回填只跳过，绝不静默删除历史污染；删除仅由显式 cleanup 调用。
      return { kind: "skipped", reason: decision.reason };
    }

    const entry: MemoryEntry = {
      id: decision.value.sourceId,
      layer: decision.value.layer,
      contentType: decision.value.contentType,
      sourceId: decision.value.sourceId,
      sourceTable: decision.value.sourceTable,
      conversationId: decision.value.conversationId ?? null,
      granularity: decision.value.granularity,
      content: decision.value.content,
      metadata: decision.value.metadata ?? null,
      createdAt,
    };
    const { contentChanged, generation, contentHash } = this.store.upsertEntryProjection(entry);
    return contentChanged
      ? { kind: "projected", entryId: entry.id, content: entry.content, generation, contentHash }
      : { kind: "unchanged", entryId: entry.id };
  }
}
