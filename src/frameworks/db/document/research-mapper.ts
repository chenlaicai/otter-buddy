import type { ResearchDocument, ResearchStatus, ExplorationType } from "../../../entities/document/research";

/** Research 表的 Row 类型 */
export interface ResearchRow {
  id: string;
  title: string;
  summary: string;
  exploration_type: string;
  status: string;
  tags: string;
  conclusion: string | null;
  causal_links_from: string;
  supersedes: string;
  file_path: string;
  created_at: string;
}

/** Row -> Entity */
export function rowToEntity(row: ResearchRow): ResearchDocument {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    explorationType: row.exploration_type as ExplorationType,
    status: row.status as ResearchStatus,
    tags: JSON.parse(row.tags),
    conclusion: row.conclusion,
    causalLinksFrom: JSON.parse(row.causal_links_from),
    supersedes: JSON.parse(row.supersedes),
    filePath: row.file_path,
    createdAt: row.created_at,
  };
}

/** Entity -> Row */
export function entityToRow(doc: ResearchDocument): ResearchRow {
  return {
    id: doc.id,
    title: doc.title,
    summary: doc.summary,
    exploration_type: doc.explorationType,
    status: doc.status,
    tags: JSON.stringify(doc.tags),
    conclusion: doc.conclusion,
    causal_links_from: JSON.stringify(doc.causalLinksFrom),
    supersedes: JSON.stringify(doc.supersedes),
    file_path: doc.filePath,
    created_at: doc.createdAt,
  };
}
