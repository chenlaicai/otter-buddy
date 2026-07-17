import type { TerminologyEntry } from "@entities/memory/terminology-entry";

export interface TerminologyRepository {
  add(entry: TerminologyEntry): Promise<void>;
  update(entry: TerminologyEntry): Promise<void>;
  getByTerm(term: string): Promise<TerminologyEntry | null>;
  search(query: string, limit: number): Promise<TerminologyEntry[]>;
  /** 种子数据同步：比对差异，新增/更新，保留运行时用户添加的术语 */
  syncSeed(entries: TerminologyEntry[]): Promise<void>;
}
