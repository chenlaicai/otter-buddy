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
  role?: { name: string; responsibilities: string[] };
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
