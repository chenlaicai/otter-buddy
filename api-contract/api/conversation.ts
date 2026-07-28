/** 对话响应 DTO */
export interface ConversationDTO {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

/** 对话列表项 DTO（含 otterIds） */
export interface ConversationListItemDTO extends ConversationDTO {
  otterIds: string[];
}

/** 创建对话请求 DTO */
export interface CreateConversationRequestDTO {
  title: string;
  otterIds?: string[];
}

/** 参与者 DTO */
export interface ParticipantDTO {
  id: string;
  conversationId: string;
  otterId: string;
  otterName: string;
  /** otter 类型（big/small），查询时从 otters 表解析 */
  otterType?: string;
  /** otter 角色名（小獭的角色，如"审查獭"） */
  roleName?: string;
  joinedAtTurnNumber: number;
  leftAtTurnNumber: number | null;
  status: string;
  createdAt: string;
  leftAt: string | null;
}
