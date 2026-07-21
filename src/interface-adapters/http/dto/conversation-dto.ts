import type { Conversation, ConversationParticipant } from "@entities/conversation/conversation";
import type {
  ConversationDTO,
  ConversationListItemDTO,
  ParticipantDTO,
} from "@contract/api/conversation";

export type { ConversationDTO, ConversationListItemDTO, ParticipantDTO };
export type { CreateConversationRequestDTO } from "@contract/api/conversation";

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

export function toParticipantDTO(p: ConversationParticipant, otterName: string): ParticipantDTO {
  return {
    id: p.id,
    conversationId: p.conversationId,
    otterId: p.otterId,
    otterName,
    joinedAtTurnNumber: p.joinedAtTurnNumber,
    leftAtTurnNumber: p.leftAtTurnNumber,
    status: p.status,
    createdAt: p.createdAt,
    leftAt: p.leftAt,
  };
}
