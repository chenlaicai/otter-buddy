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
    /** F20260920imax：助理对话标识改 schema 字段单一真相源（原 title 前缀约定退役；
     *  存量库由迁移回填，见 migration.ts ensureConversationsKindColumn） */
    ...(conv.kind === "assistant" && { kind: "assistant" }),
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    completedAt: conv.completedAt,
    archivedAt: conv.archivedAt,
  };
}

/** F20260918imas：助理对话标题判定（开户命名展示用）。F20260920imax：分组/DTO 标识已改
 *  读 conversation.kind，本函数仅迁移回填与展示用途保留。
 *  WARNING: 不可用于 kind 判定（真相源是 conv.kind schema 字段）——误用会绕过 kind 字段重引入旧 title 约定依赖 */
export function isAssistantConversationTitle(title: string): boolean {
  return title.startsWith("微信助理 · ") || title.startsWith("飞书助理 · ");
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
  extra?: { otterType?: string; roleName?: string; modelAlias?: string; modelIsDefault?: boolean },
): ParticipantDTO {
  return {
    id: p.id,
    conversationId: p.conversationId,
    otterId: p.otterId,
    otterName,
    ...(extra?.otterType !== undefined && { otterType: extra.otterType }),
    ...(extra?.roleName !== undefined && { roleName: extra.roleName }),
    ...(extra?.modelAlias !== undefined && { modelAlias: extra.modelAlias }),
    ...(extra?.modelIsDefault !== undefined && { modelIsDefault: extra.modelIsDefault }),
    status: p.status,
    createdAt: p.createdAt,
    leftAt: p.leftAt,
  };
}
