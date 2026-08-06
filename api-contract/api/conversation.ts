/** 对话响应 DTO */
export interface ConversationDTO {
  id: string;
  title: string;
  status: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

/** 对话列表项 DTO（含 otterIds + 未读计数 + 最后消息预览） */
export interface ConversationListItemDTO extends ConversationDTO {
  otterIds: string[];
  /** 未读消息计数（消息级，基于 last_read_message_seq） */
  unreadCount?: number;
  /** 最后一条消息预览（剥离 HTML 标签后前 50 字符） */
  lastMessagePreview?: string | null;
  /** 最后一条消息时间戳 */
  lastMessageTs?: string | null;
  /** 实时活动状态（派生字段，非持久化）
   *  - processing: 存在 streaming/speaking 消息，海獭正在生成
   *  - awaiting_user: 活跃对话 + 无进行中消息 + 至少一条消息，等待用户发话
   *  - idle: 已完成/归档，或活跃但尚无消息
   */
  activityStatus?: 'processing' | 'awaiting_user' | 'idle';
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
