/** Research 文档状态 */
export type ResearchStatus = "draft" | "development" | "locked" | "archived";

/** Research 探索类型 */
export type ExplorationType = "technical" | "market" | "user-research";

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
