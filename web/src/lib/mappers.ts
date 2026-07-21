import type { OtterDTO, ConversationListItemDTO, MessageDTO, OtterSessionDTO, LinkedResourceDTO } from '@contract/api'

/** 前端本地 Otter 类型（UI 渲染用） */
export interface LocalOtter {
  id: string
  name: string
  type: 'big' | 'small'
  createdAt: string
  role?: { name: string; resp: string[] }
  parentOtterId?: string
  ci?: number
}

/** 前端本地 Conversation 类型 */
export interface LocalConversation {
  id: string
  title: string
  status: 'active' | 'completed' | 'archived'
  otterIds: string[]
}

/** 前端本地消息事件 */
export interface LocalMessageEvent {
  eventType: string
  payload: Record<string, unknown>
}

/** 前端本地 Message 类型 */
export interface LocalMessage {
  id: string
  st: 'user' | 'otter'
  si: string
  content: string
  ts: string
  dur: string | null
  events?: LocalMessageEvent[]
  ctx?: number
  ctxMax?: number
}

/** 前端本地 LinkedResource 类型（统一产物模型） */
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
  status: 'active' | 'archived'
  startedAt: string
  archivedAt: string | null
  archiveReason: string | null
  isNegativeCase: boolean
  summary: string | null
}

export function mapOtterDTO(dto: OtterDTO, ci?: number): LocalOtter {
  return {
    id: dto.id,
    name: dto.name,
    type: dto.type as 'big' | 'small',
    createdAt: dto.createdAt.split('T')[0],
    role: dto.role ? { name: dto.role.name, resp: dto.role.responsibilities } : undefined,
    parentOtterId: dto.parentOtterId ?? undefined,
    ci,
  }
}

export function mapConversationDTO(dto: ConversationListItemDTO): LocalConversation {
  return {
    id: dto.id,
    title: dto.title,
    status: dto.status as 'active' | 'completed' | 'archived',
    otterIds: dto.otterIds,
  }
}

export function mapMessageDTO(dto: MessageDTO): LocalMessage {
  return {
    id: dto.id,
    st: dto.st as 'user' | 'otter',
    si: dto.si,
    content: dto.content ?? '',
    ts: dto.ts,
    dur: dto.dur,
    ctx: dto.ctx,
    ctxMax: dto.ctxMax,
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
    status: dto.status as 'active' | 'archived',
    startedAt: dto.startedAt,
    archivedAt: dto.archivedAt,
    archiveReason: dto.archiveReason,
    isNegativeCase: dto.isNegativeCase,
    summary: dto.summary,
  }
}
