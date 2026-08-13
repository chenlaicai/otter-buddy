import type { FeatureDocument } from "../../entities/document/feature";

/** Feature 文档 Repository 接口 */
export interface FeatureRepository {
  /** 根据 ID 查找 */
  findById(id: string): Promise<FeatureDocument | null>;

  /** 查找所有 */
  findAll(): Promise<FeatureDocument[]>;

  /** 插入新文档 */
  insert(doc: FeatureDocument): Promise<void>;

  /** 更新状态 */
  updateStatus(id: string, status: FeatureDocument["status"]): Promise<void>;

  /** F20260803mval: 更新文档内容（upsert 场景，内容指纹变了重新 index） */
  updateContent(doc: FeatureDocument): Promise<void>;

  /** F20260813mren: 读取文档的对话 provenance（事实级，非推断） */
  getCreatedInConversationId(id: string): Promise<string | null>;
}
