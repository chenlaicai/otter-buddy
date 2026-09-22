/** 对话响应 DTO */
export interface ConversationDTO {
  id: string;
  title: string;
  /** F20260922cgrp：弱状态两态管理——completed 退役，只剩 active | archived */
  status: "active" | "archived";
  pinned: boolean;
  /** F20260918imas：助理对话标识（微信/飞书 IM 自动开户；缺省 = 普通对话。前端左侧栏分组依据） */
  kind?: "assistant";
  createdAt: string;
  updatedAt: string;
  /** F20260922cgrp：completed 状态退役，字段保留（DB 列不动，历史数据可读，恒为 null 或旧值） */
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

/** F20260922cgrp：对话列表响应——items + total（total 供分组分页页码跳转） */
export interface ConversationListResponseDTO {
  items: ConversationListItemDTO[];
  /** 满足过滤条件的总数（不含 limit/offset） */
  total: number;
}

/** 创建对话请求 DTO */
export interface CreateConversationRequestDTO {
  title: string;
  otterIds?: string[];
  /** 新建对话时大獭的模型自选（可选，缺省 = 配置文件默认模型） */
  modelAlias?: string;
}

/** 参与者 DTO */
export interface ParticipantDTO {
  id: string;
  conversationId: string;
  otterId: string;
  otterName: string;
  /** otter 类型（big/small），查询时从 otters 表解析 */
  otterType?: string;
  /** F20260921otcl：出生颜色（色板 key，如 'teal'；大獭/未回填为 null）——从 otters 表解析 */
  otterColor?: string | null;
  /** otter 角色名（小獭的角色，如"审查獭"） */
  roleName?: string;
  /** 模型别名（有效模型解析后，恒非空——默认模型回退后也有值） */
  modelAlias?: string;
  /** F20260908efmd: true = 配置未显式指定，跟随默认 */
  modelIsDefault?: boolean;
  status: string;
  createdAt: string;
  leftAt: string | null;
}
