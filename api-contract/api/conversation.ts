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

/** 附件值对象 */
export interface Attachment {
  type: string;
  url: string;
  name?: string;
}

/** 参与者 DTO */
export interface ParticipantDTO {
  id: string;
  conversationId: string;
  otterId: string;
  otterName: string;
  joinedAtTurnNumber: number;
  leftAtTurnNumber: number | null;
  status: string;
  createdAt: string;
  leftAt: string | null;
}
