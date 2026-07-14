/**
 * domain/otter 领域模型类型定义。
 *
 * Otter 模块管理海獭实例的数据记录 + pi-agent 实例生命周期。
 */

export type OtterType = "big" | "small";
export type OtterStatus = "active" | "dissolved";
export type SessionStatus = "active" | "archived" | "restarted";

export interface OtterRole {
  name: string;
  /** S3 DDL: JSON array of strings */
  responsibilities: string[];
}

export interface Otter {
  id: string;
  name: string;
  type: OtterType;
  status: OtterStatus;
  role: OtterRole | null;
  parentOtterId: string | null;
  createdAt: string;
  dissolvedAt: string | null;
}

export interface OtterSession {
  id: string;
  otterId: string;
  status: SessionStatus;
  startedAt: string;
  archivedAt: string | null;
  archiveReason: string | null;
  isNegativeCase: boolean;
  summary: string | null;
}

export interface CreateOtterInput {
  name: string;
  type: OtterType;
  roleName?: string;
  roleResponsibilities?: string[];
  parentOtterId?: string;
  /** Agent 系统提示词（大獭用默认 prompt，小獭由 app/orchestration 根据角色生成） */
  systemPrompt?: string;
  /** Agent 初始上下文（如小獭创建时注入的相关记忆/前情摘要） */
  context?: string;
}

export interface ArchiveSessionInput {
  /** 'restart' | 'dissolve' | 'manual' */
  reason: string;
  isNegativeCase?: boolean;
  summary?: string;
}
