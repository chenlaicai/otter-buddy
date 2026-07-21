/** Feature 文档状态 */
export type FeatureStatus = "draft" | "development" | "locked" | "archived";

/** Feature 变更类型 */
export type ChangeType = "feature" | "refactor" | "fix";

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
