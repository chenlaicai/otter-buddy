/**
 * P2b1：consolidation_state 仓库 port（窄接口）。
 *
 * 语义：按幂等键读写治量状态行。读写分离交给 usecase（ManageConsolidationState），
 * 本 port 只提供 getByKey + save 全量 upsert——SQLite 单写者下先读后写足够安全。
 */
import type { ConsolidationState } from "@entities/memory/consolidation-state";

export interface ConsolidationStateRepository {
  /** 按幂等键取行；不存在返回 null */
  getByKey(reviewKey: string): Promise<ConsolidationState | null>;
  /** 全量 upsert（INSERT OR REPLACE，幂等） */
  save(state: ConsolidationState): Promise<void>;
}