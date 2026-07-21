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
}
