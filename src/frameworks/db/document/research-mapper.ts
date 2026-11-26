import type { ResearchDocument, ResearchStatus, ExplorationType } from "../../../entities/document/research";
import { isKnownExplorationType } from "../../../entities/document/known-values";

/** Research 表的 Row 类型 */
export interface ResearchRow {
  id: string;
  title: string;
  summary: string;
  body_hash: string | null;
  exploration_type: string;
  status: string;
  tags: string;
  conclusion: string | null;
  causal_links_from: string;
  supersedes: string;
  file_path: string;
  created_at: string;
  created_in_conversation_id: string | null;
}

/** Row -> Entity */
export function rowToEntity(row: ResearchRow): ResearchDocument {
  // 读取侧 isKnown 校验
  const et = row.exploration_type;
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    bodyHash: row.body_hash,
    explorationType: (isKnownExplorationType(et) ? et : "technical") as ExplorationType,
    // status 值域已收敛：透传 DB 值（active/archived/历史遗留），不再归一到 draft
    status: row.status as ResearchStatus,
    tags: JSON.parse(row.tags),
    conclusion: row.conclusion,
    causalLinksFrom: JSON.parse(row.causal_links_from),
    supersedes: JSON.parse(row.supersedes),
    filePath: row.file_path,
    createdAt: row.created_at,
    createdInConversationId: row.created_in_conversation_id ?? null,
  };
}

/** Entity -> Row */
export function entityToRow(doc: ResearchDocument): ResearchRow {
  return {
    id: doc.id,
    title: doc.title,
    summary: doc.summary,
    body_hash: doc.bodyHash,
    exploration_type: doc.explorationType,
    status: doc.status,
    tags: JSON.stringify(doc.tags),
    conclusion: doc.conclusion,
    causal_links_from: JSON.stringify(doc.causalLinksFrom),
    supersedes: JSON.stringify(doc.supersedes),
    file_path: doc.filePath,
    created_at: doc.createdAt,
    created_in_conversation_id: doc.createdInConversationId ?? null,
  };
}
