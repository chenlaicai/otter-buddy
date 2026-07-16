import type { Otter, OtterRole } from "@entities/otter/otter";
import type { OtterSession } from "@entities/otter/otter-session";

/** Otter 响应 DTO */
export interface OtterDTO {
  id: string;
  name: string;
  type: string;
  status: string;
  role: { name: string; responsibilities: string[] } | null;
  parentOtterId: string | null;
  createdAt: string;
  dissolvedAt: string | null;
}

/** 创建 Otter 请求 DTO */
export interface CreateOtterRequestDTO {
  name: string;
  type: "big" | "small";
  role?: OtterRole;
  parentOtterId?: string;
  systemPrompt: string;
  context?: Record<string, unknown>;
}

/** Otter Session DTO */
export interface OtterSessionDTO {
  id: string;
  otterId: string;
  status: string;
  previousSessionId: string | null;
  startedAt: string;
  archivedAt: string | null;
  archiveReason: string | null;
  isNegativeCase: boolean;
  summary: string | null;
}

export function toOtterDTO(otter: Otter): OtterDTO {
  return {
    id: otter.id,
    name: otter.name,
    type: otter.type,
    status: otter.status,
    role: otter.role,
    parentOtterId: otter.parentOtterId,
    createdAt: otter.createdAt,
    dissolvedAt: otter.dissolvedAt,
  };
}

export function toOtterSessionDTO(session: OtterSession): OtterSessionDTO {
  return {
    id: session.id,
    otterId: session.otterId,
    status: session.status,
    previousSessionId: session.previousSessionId,
    startedAt: session.startedAt,
    archivedAt: session.archivedAt,
    archiveReason: session.archiveReason,
    isNegativeCase: session.isNegativeCase,
    summary: session.summary,
  };
}
