export type TerminologyStatus = "active" | "deprecated";

export interface TerminologyEntry {
  id: string;
  term: string;
  aliases: string[];
  definition: string;
  context: string | null;
  examples: string[] | null;
  category: string | null;
  status: TerminologyStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** deprecated 术语不参与检索，但保留记录避免引用断裂 */
export function isTerminologySearchable(entry: TerminologyEntry): boolean {
  return entry.status === "active";
}
