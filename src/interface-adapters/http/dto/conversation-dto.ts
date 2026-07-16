import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";

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
  joinedAtTurnNumber: number;
  leftAtTurnNumber: number | null;
  status: string;
  createdAt: string;
  leftAt: string | null;
}

export function toConversationDTO(conv: Conversation): ConversationDTO {
  return {
    id: conv.id,
    title: conv.title,
    status: conv.status,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    completedAt: conv.completedAt,
    archivedAt: conv.archivedAt,
  };
}

export function toConversationListItemDTO(
  conv: Conversation,
  otterIds: string[],
): ConversationListItemDTO {
  return { ...toConversationDTO(conv), otterIds };
}

export function toParticipantDTO(p: ConversationParticipant): ParticipantDTO {
  return {
    id: p.id,
    conversationId: p.conversationId,
    otterId: p.otterId,
    joinedAtTurnNumber: p.joinedAtTurnNumber,
    leftAtTurnNumber: p.leftAtTurnNumber,
    status: p.status,
    createdAt: p.createdAt,
    leftAt: p.leftAt,
  };
}
