import type { OtterDTO, ConversationDTO, ConversationListItemDTO, MessageDTO, OtterSessionDTO, LinkedResourceDTO, ParticipantDTO } from '@contract/api'

/** 前端本地 Otter 类型（UI 渲染用） */
export interface LocalOtter {
  id: string
  name: string
  type: 'big' | 'small'
  createdAt: string
  role?: { name: string; resp: string[] }
  parentOtterId?: string
}

/** 前端本地 Conversation 类型 */
export interface LocalConversation {
  id: string
  title: string
  status: 'active' | 'completed' | 'archived'
  pinned: boolean
  otterIds: string[]
  /** 未读消息计数（消息级） */
  unreadCount?: number
  /** 最后一条消息预览 */
  lastMessagePreview?: string | null
  /** 最后一条消息时间戳 */
  lastMessageTs?: string | null
  /** 实时活动状态（派生字段） */
  activityStatus?: 'processing' | 'awaiting_user' | 'idle'
}

/** 前端本地消息事件 */
export interface LocalMessageEvent {
  ts: string
  eventType: string
  payload: Record<string, unknown>
}

/** 前端本地消息状态（对齐后端 MessageStatus） */
export type LocalMessageStatus = 'streaming' | 'speaking' | 'completed' | 'failed' | 'aborted'

/** 前端本地 Message 类型 */
export interface LocalMessage {
  id: string
  st: 'user' | 'otter' | 'system'
  si: string
  /** 发送者显示名（otter 消息来自后端投影，实时消息来自 message.start） */
  sn?: string
  content: string
  /** 消息生命周期状态；仅历史查询（DTO）路径携带，SSE 实时构造的消息为 undefined（视同 completed/对应事件态） */
  status?: LocalMessageStatus
  /** 服务端序列号（时序依据）；tmp 乐观消息无 seq */
  seq?: number
  ts: string
  dur: string | null
  events?: LocalMessageEvent[]
  ctx?: number
  ctxMax?: number
  turnId?: string
  /** 消息来源 "web" | "feishu" */
  src?: 'web' | 'feishu'
}

/** 前端本地 LinkedResource 类型（统一产物模型）
 *  新旧词映射：关键资源（现名）= 链接资源/关键事实（旧称）；machine name 保留 linked_resource */
export interface LocalLinkedResource {
  id: string
  type: string
  url: string | null
  title: string
  content: string | null
  category: string | null
  flagged: boolean
  auto: boolean
}

/** 前端本地 OtterSession 类型 */
export interface LocalOtterSession {
  id: string
  otterId: string
  status: 'active' | 'archived' | 'restarted'
  previousSessionId: string | null
  startedAt: string
  archivedAt: string | null
  archiveReason: string | null
  isNegativeCase: boolean
  summary: string | null
}

export function mapOtterDTO(dto: OtterDTO): LocalOtter {
  return {
    id: dto.id,
    name: dto.name,
    type: dto.type as 'big' | 'small',
    createdAt: dto.createdAt.split('T')[0],
    role: dto.role ? { name: dto.role.name, resp: dto.role.responsibilities } : undefined,
    parentOtterId: dto.parentOtterId ?? undefined,
  }
}

export function mapConversationDTO(dto: ConversationListItemDTO | ConversationDTO): LocalConversation {
  return {
    id: dto.id,
    title: dto.title,
    status: dto.status as 'active' | 'completed' | 'archived',
    pinned: dto.pinned,
    otterIds: 'otterIds' in dto ? dto.otterIds : [],
    ...('unreadCount' in dto && { unreadCount: dto.unreadCount }),
    ...('lastMessagePreview' in dto && { lastMessagePreview: dto.lastMessagePreview }),
    ...('lastMessageTs' in dto && { lastMessageTs: dto.lastMessageTs }),
    ...('activityStatus' in dto && { activityStatus: dto.activityStatus as LocalConversation['activityStatus'] }),
  }
}

export function mapMessageDTO(dto: MessageDTO): LocalMessage {
  return {
    id: dto.id,
    st: dto.st as 'user' | 'otter' | 'system',
    si: dto.si,
    sn: dto.sn,
    content: dto.content ?? '',
    status: dto.status as LocalMessageStatus,
    seq: dto.seq,
    ts: dto.ts,
    dur: dto.dur,
    ctx: dto.ctx,
    ctxMax: dto.ctxMax,
    turnId: dto.turnId,
    src: dto.src as 'web' | 'feishu' | undefined,
  }
}

/** 参与者 DTO → LocalOtter（ParticipantDTO 投影已含 type/roleName） */
export function mapParticipantDTO(p: ParticipantDTO): LocalOtter {
  return {
    id: p.otterId,
    name: p.otterName,
    type: (p.otterType as 'big' | 'small') ?? 'small',
    createdAt: '',
    role: p.roleName ? { name: p.roleName, resp: [] } : undefined,
  }
}

export function mapLinkedResourceDTO(dto: LinkedResourceDTO): LocalLinkedResource {
  return {
    id: dto.id,
    type: dto.resourceType,
    url: dto.url,
    title: dto.title ?? dto.content ?? dto.url ?? '',
    content: dto.content,
    category: dto.category,
    flagged: dto.userFlagged,
    auto: dto.autoLinked,
  }
}

export function mapSessionDTO(dto: OtterSessionDTO): LocalOtterSession {
  return {
    id: dto.id,
    otterId: dto.otterId,
    status: dto.status as 'active' | 'archived' | 'restarted',
    previousSessionId: dto.previousSessionId,
    startedAt: dto.startedAt,
    archivedAt: dto.archivedAt,
    archiveReason: dto.archiveReason,
    isNegativeCase: dto.isNegativeCase,
    summary: dto.summary,
  }
}

// ── Scheduled Task 类型 ──

/** 前端本地 ScheduledTask 类型 */
export interface LocalScheduledTask {
  id: string
  conversationId: string
  name: string
  scheduleType: 'cron' | 'once'
  cron: string
  triggerAt: string | null
  timezone: string
  body: string
  talkingStonePassedTo: string[]
  senderId: string
  status: 'active' | 'disabled' | 'error'
  consecutiveFailures: number
  lastTriggeredAt: string | null
  restartBeforeInvoke: boolean
  nextTriggerAt: string | null
  createdAt: string
  updatedAt: string
}

/** 前端本地 ScheduledTaskExecution 类型 */
export interface LocalScheduledTaskExecution {
  id: string
  taskId: string
  triggeredAt: string
  completedAt: string | null
  status: 'running' | 'completed' | 'failed'
  errorMessage: string | null
  messageId: string | null
  turnId: string | null
}

export interface ScheduledTaskDTO {
  id: string
  conversationId: string
  name: string
  scheduleType: 'cron' | 'once'
  cron: string
  triggerAt: string | null
  timezone: string
  body: string
  talkingStonePassedTo: string[]
  senderId: string
  status: string
  consecutiveFailures: number
  lastTriggeredAt: string | null
  restartBeforeInvoke: boolean
  nextTriggerAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ScheduledTaskExecutionDTO {
  id: string
  taskId: string
  triggeredAt: string
  completedAt: string | null
  status: string
  errorMessage: string | null
  messageId: string | null
  turnId: string | null
}

export function mapScheduledTaskDTO(dto: ScheduledTaskDTO): LocalScheduledTask {
  return {
    id: dto.id,
    conversationId: dto.conversationId,
    name: dto.name,
    scheduleType: dto.scheduleType,
    cron: dto.cron,
    triggerAt: dto.triggerAt,
    timezone: dto.timezone,
    body: dto.body,
    talkingStonePassedTo: dto.talkingStonePassedTo,
    senderId: dto.senderId,
    status: dto.status as 'active' | 'disabled' | 'error',
    consecutiveFailures: dto.consecutiveFailures,
    lastTriggeredAt: dto.lastTriggeredAt,
    restartBeforeInvoke: dto.restartBeforeInvoke,
    nextTriggerAt: dto.nextTriggerAt,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  }
}

export function mapExecutionDTO(dto: ScheduledTaskExecutionDTO): LocalScheduledTaskExecution {
  return {
    id: dto.id,
    taskId: dto.taskId,
    triggeredAt: dto.triggeredAt,
    completedAt: dto.completedAt,
    status: dto.status as 'running' | 'completed' | 'failed',
    errorMessage: dto.errorMessage,
    messageId: dto.messageId,
    turnId: dto.turnId,
  }
}
