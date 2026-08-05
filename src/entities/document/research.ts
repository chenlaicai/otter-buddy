import type { ResearchStatus, ExplorationType } from "./known-values";

/** Research 文档状态、探索类型：从 known-values 单一真相源派生（F20260803mval） */
export type { ResearchStatus, ExplorationType } from "./known-values";

/** Research 文档实体 */
export interface ResearchDocument {
  id: string;
  title: string;
  summary: string;
  /** F20260803fbit: 正文清理后的 sha256 前 16 字符，驱动 upsert 指纹比较 */
  bodyHash: string | null;
  explorationType: ExplorationType;
  status: ResearchStatus;
  tags: string[];
  conclusion: string | null;
  causalLinksFrom: string[];
  supersedes: string[];
  filePath: string;
  createdAt: string;
}
