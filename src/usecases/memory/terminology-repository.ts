import type { TerminologyEntry } from "@entities/memory/terminology-entry";

export interface TerminologyRepository {
  add(entry: TerminologyEntry): Promise<void>;
  update(entry: TerminologyEntry): Promise<void>;
  getById(id: string): Promise<TerminologyEntry | null>;
  getByTerm(term: string): Promise<TerminologyEntry | null>;
  search(query: string, limit: number): Promise<TerminologyEntry[]>;
  /** 种子数据导入（仅在表为空时执行） */
  seed(entries: TerminologyEntry[]): Promise<void>;
}
