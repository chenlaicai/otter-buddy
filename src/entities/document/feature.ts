import type { ChangeType, FeatureStatus } from "./known-values";

/** Feature 文档状态、变更类型：从 known-values 单一真相源派生（F20260803mval） */
export type { ChangeType, FeatureStatus } from "./known-values";

/** Feature 文档实体 */
export interface FeatureDocument {
  id: string;
  title: string;
  summary: string;
  changeType: ChangeType;
  status: FeatureStatus;
  tags: string[];
  modules: string[];
  causalLinksFrom: string[];
  supersedes: string[];
  filePath: string;
  createdAt: string;
}
