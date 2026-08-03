import type { FeatureDocument, FeatureStatus, ChangeType } from "../../../entities/document/feature";
import { isKnownChangeType, isKnownFeatureStatus } from "../../../entities/document/known-values";

/** Feature 表的 Row 类型 */
export interface FeatureRow {
  id: string;
  title: string;
  summary: string;
  change_type: string;
  status: string;
  tags: string;
  modules: string;
  causal_links_from: string;
  supersedes: string;
  file_path: string;
  created_at: string;
}

/** Row -> Entity */
export function rowToEntity(row: FeatureRow): FeatureDocument {
  // F20260803mval: 读取侧 isKnown 校验，防非 sync 路径写入的未知值绕过类型安全（S2）
  const ct = row.change_type;
  const st = row.status;
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    changeType: (isKnownChangeType(ct) ? ct : "feature") as ChangeType,
    status: (isKnownFeatureStatus(st) ? st : "draft") as FeatureStatus,
    tags: JSON.parse(row.tags),
    modules: JSON.parse(row.modules),
    causalLinksFrom: JSON.parse(row.causal_links_from),
    supersedes: JSON.parse(row.supersedes),
    filePath: row.file_path,
    createdAt: row.created_at,
  };
}

/** Entity -> Row */
export function entityToRow(doc: FeatureDocument): FeatureRow {
  return {
    id: doc.id,
    title: doc.title,
    summary: doc.summary,
    change_type: doc.changeType,
    status: doc.status,
    tags: JSON.stringify(doc.tags),
    modules: JSON.stringify(doc.modules),
    causal_links_from: JSON.stringify(doc.causalLinksFrom),
    supersedes: JSON.stringify(doc.supersedes),
    file_path: doc.filePath,
    created_at: doc.createdAt,
  };
}
