import type { ChangeType, FeatureStatus } from "./known-values";

/** Feature 文档状态、变更类型：从 known-values 单一真相源派生（F20260803mval） */
export type { ChangeType, FeatureStatus } from "./known-values";

/** Feature 文档实体 */
export interface FeatureDocument {
  id: string;
  title: string;
  summary: string;
  /** F20260803fbit: 正文清理后的 sha256 前 16 字符，驱动 upsert 指纹比较 */
  bodyHash: string | null;
  changeType: ChangeType;
  status: FeatureStatus;
  tags: string[];
  modules: string[];
  causalLinksFrom: string[];
  supersedes: string[];
  filePath: string;
  createdAt: string;
  /** F20260813mren: 文档产出自哪段对话（事实级 provenance，非推断） */
  createdInConversationId?: string | null;
}
