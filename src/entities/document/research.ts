import type { ResearchStatus, ExplorationType } from "./known-values";

/** Research 文档状态、探索类型：从 known-values 单一真相源派生（F20260803mval） */
export type { ResearchStatus, ExplorationType } from "./known-values";

/** Research 文档实体 */
export interface ResearchDocument {
  id: string;
  title: string;
  summary: string;
  explorationType: ExplorationType;
  status: ResearchStatus;
  tags: string[];
  conclusion: string | null;
  causalLinksFrom: string[];
  supersedes: string[];
  filePath: string;
  createdAt: string;
}
