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
    pinned: conv.pinned,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    completedAt: conv.completedAt,
    archivedAt: conv.archivedAt,
  };
}

export function toConversationListItemDTO(
  conv: Conversation,
  otterIds: string[],
  extra?: { unreadCount?: number; lastMessagePreview?: string | null; lastMessageTs?: string | null; activityStatus?: 'processing' | 'awaiting_user' | 'idle' },
): ConversationListItemDTO {
  return {
    ...toConversationDTO(conv),
    otterIds,
    ...(extra?.unreadCount !== undefined && { unreadCount: extra.unreadCount }),
    ...(extra?.lastMessagePreview !== undefined && { lastMessagePreview: extra.lastMessagePreview }),
    ...(extra?.lastMessageTs !== undefined && { lastMessageTs: extra.lastMessageTs }),
    ...(extra?.activityStatus !== undefined && { activityStatus: extra.activityStatus }),
  };
}

export function toParticipantDTO(
  p: ConversationParticipant,
  otterName: string,
  extra?: { otterType?: string; roleName?: string; modelAlias?: string },
): ParticipantDTO {
  return {
    id: p.id,
    conversationId: p.conversationId,
    otterId: p.otterId,
    otterName,
    ...(extra?.otterType !== undefined && { otterType: extra.otterType }),
    ...(extra?.roleName !== undefined && { roleName: extra.roleName }),
    ...(extra?.modelAlias !== undefined && { modelAlias: extra.modelAlias }),
    joinedAtTurnNumber: p.joinedAtTurnNumber,
    leftAtTurnNumber: p.leftAtTurnNumber,
    status: p.status,
    createdAt: p.createdAt,
    leftAt: p.leftAt,
  };
}
