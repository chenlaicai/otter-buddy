import type { ResearchDocument } from "../../entities/document/research";

/** Research 文档 Repository 接口 */
export interface ResearchRepository {
  /** 根据 ID 查找 */
  findById(id: string): Promise<ResearchDocument | null>;

  /** F20260901dsyn: 按 file_path 查找（id 漂移诊断——磁盘文档 id 与同路径 DB 记录不一致） */
  findByFilePath(filePath: string): Promise<ResearchDocument | null>;

  /** 查找所有 */
  findAll(): Promise<ResearchDocument[]>;

  /** 插入新文档 */
  insert(doc: ResearchDocument): Promise<void>;

  /** 更新状态 */
  updateStatus(id: string, status: ResearchDocument["status"]): Promise<void>;

  /** F20260803mval: 更新文档内容（upsert 场景，内容指纹变了重新 index） */
  updateContent(doc: ResearchDocument): Promise<void>;

  /** F20260813mren: 读取文档的对话 provenance（事实级，非推断） */
  getCreatedInConversationId(id: string): Promise<string | null>;
}
