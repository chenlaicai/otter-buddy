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
  /** F20260827ucrt：UI 入口模型自选。与大獭工具链同源语义——须为 config.yaml models[] 合法 alias，
   *  缺省用默认模型；controller 层校验（settings-controller hasModel 同层先例）。
   *  注：大獭工具入口走 otter-tool-client（modelAlias 存 otter_configs），不经此 DTO */
  modelAlias?: string;
  /** F20260827ucrt T4：UI 入口（POST /api/otters）忽略此字段，血缘诚实落 null；
   *  大獭工具链走 otter-tool-client 系统注入，不经此 DTO */
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

/** Otter 面板 Profile DTO（聚合端点 GET /api/otters/:id/profile） */
export interface OtterProfileDTO {
  id: string;
  name: string;
  type: 'big' | 'small';
  roleName: string | null;
  modelAlias: string | null;
  modelDescriptor: {
    alias: string;
    description?: string;
    strengths?: string[];
    weaknesses?: string[];
    contextWindow?: number;
  } | null;
  /** Otter 级系统提示词（不含平台 base 和身份注入）；大獭通常为 null */
  systemPrompt: string | null;
  skills: Array<{ name: string; description: string; category: string }>;
  tools: Array<{ name: string; description: string; group?: string }>;
  stats: {
    messageCount: number;
    artifactCount: number;
    conversationCount: number;
  };
}
