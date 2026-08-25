/** 系统提醒（per-Otter，运行时注入） */
export interface SystemReminder {
  content: string;
  priority?: "low" | "medium" | "high";
}

/** Per-Otter 提示词配置（可选叠加到平台 prompt） */
export interface OtterPromptConfig {
  systemPrompt?: string;
  reminders?: SystemReminder[];
}

/** Otter 响应 DTO */
export interface OtterDTO {
  id: string;
  name: string;
  type: string;
  status: string;
  role: { name: string; responsibilities: string[] } | null;
  /** 模型别名（多模型路由，如 "mimo"）；未配置（大獭/老数据/默认模型）时不返回 */
  modelAlias?: string;
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
  /** Otter 级系统提示词（可选，与平台 prompt 叠加） */
  systemPrompt?: string | OtterPromptConfig;
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
