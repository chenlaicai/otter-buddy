import type { OtterDTO, ConversationDTO, ConversationListItemDTO, MessageDTO, OtterSessionDTO, LinkedResourceDTO, ParticipantDTO, EntryDTO } from '@contract/api'

/** 前端本地 Otter 类型（UI 渲染用） */
export interface LocalOtter {
  id: string
  name: string
  type: 'big' | 'small'
  createdAt: string
  role?: { name: string; resp: string[] }
  parentOtterId?: string
  /** 模型别名（有效模型解析后，恒非空——默认模型回退后也有值） */
  modelAlias?: string
  /** F20260908efmd: true = 配置未显式指定，跟随默认 */
  modelIsDefault?: boolean
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

/** 前端本地消息信号（F20260826mwrd C4：徽章数据，后端 MessageSignalDTO 投影） */
export interface LocalMessageSignal {
  id: string
  type: 'objection' | 'blocked' | 'halt'
  severity: 'low' | 'medium' | 'high'
  status: 'pending' | 'resolved' | 'dismissed'
  payload: string
  fromOtterId: string
  targetOtterId?: string | null
  resolution?: string | null
  resolvedBy?: string | null
  createdAt: string
  /** 渲染时由在场獭名映射补全（DTO 不携带名字，避免后端二次查询） */
  fromName?: string
  targetName?: string
}

/** 前端本地消息事件 */
export interface LocalMessageEvent {
  ts: string
  eventType: string
  payload: Record<string, unknown>
}

/** 前端本地消息状态（对齐后端 MessageStatus） */
export type LocalMessageStatus = 'streaming' | 'speaking' | 'completed' | 'failed' | 'aborted'

/** 前端本地消息分段（F-multi-speak-bubble） */
export interface LocalMessageSegment {
  id: string
  body: string
  sequenceNum: number
}

/** 前端本地附件（多模态 Phase 1；#608 扩 kind 值域）——与 AttachmentDTO 同构，历史/乐观两条路径共用 */
export interface LocalAttachment {
  id: string
  kind: 'image' | 'document' | 'audio' | 'video'
  originalName: string
  mimeType: string
  sizeBytes: number
  width?: number | null
  height?: number | null
}

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
  /** 消息分段（F-multi-speak-bubble）；历史消息可能无此字段 */
  segments?: LocalMessageSegment[]
  /** 消息关联信号（F20260826mwrd C4 徽章）；历史消息可能无此字段 */
  signals?: LocalMessageSignal[]
  /** 发言石目标（F20260902u5tr：信号轨迹判定用）；乐观消息/SSE 实时消息无此字段 */
  tsp?: string[] | null
  /** 多模态 Phase 1：随消息携带的附件 */
  atts?: LocalAttachment[]
  /** F20260910ctlv：时间线条目类型（speak/user 气泡渲染，其余居中特殊渲染）。
   *  旧 messages 表数据无此字段（undefined）——按 st 回退推导，历史兼容零迁移 */
  entryType?: TimelineEntryType
  /** F20260910ctlv：invoke 关联（SSE entry.* 事件携带；旧数据无） */
  invokeId?: string
  /** F20260910ctlv test17：invoke 真实终态（invoke_end entry 的 metadata.invokeStatus 透出；
   *  entries.status 是死字段全部 completed，重试按钮等终态 UI 靠它判断） */
  invokeStatus?: 'failed' | 'aborted'
  /** F20260910ctlv：yield 条目专有——行动权传递目标 */
  yieldTargets?: string[] | null
}

// ── F20260910ctlv：时间线条目类型 ──

/** 时间线条目类型（与后端 EntryType 对齐） */
export type TimelineEntryType =
  | 'speak'
  | 'user'
  | 'invoke_start'
  | 'invoke_end'
  | 'yield'
  | 'system'

/** TimelineEntry：时间线渲染视角的条目（LocalMessage 超集，向后兼容）。
 *  实现采用「字段下沉」而非新类型替换——LocalMessage 全链路（batcher/insertBySeq/
 *  乐观消息/轮询）不动，entryType 驱动 MessageList 的渲染分収；特性文档 D7：
 *  历史数据兼容优先，旧 messages 数据原样可读 */
export type TimelineEntry = LocalMessage

/** 旧消息按 st 回退推导 entryType（历史兼容：无 entryType 字段的旧数据） */
export function deriveEntryType(m: LocalMessage): TimelineEntryType {
  if (m.entryType) return m.entryType
  return m.st === 'user' ? 'user' : m.st === 'system' ? 'system' : 'speak'
}

/** invoke 边界/yield/system 条目是否居中特殊渲染（非气泡） */
export function isCenteredEntry(m: LocalMessage): boolean {
  const t = deriveEntryType(m)
  return t === 'invoke_start' || t === 'invoke_end' || t === 'yield' || t === 'system'
}

/** F20260910ctlv：invoke 边界/yield/system 条目文案（entry.body 为空时按约定文案渲染）。
 *  yield 带来源獭名（senderName）：「大獭 → 交给 user」——多獭并发时能区分是谁交的棒 */
export function centeredEntryText(m: LocalMessage): string {
  const t = deriveEntryType(m)
  const name = m.sn || m.si || '獭'
  // yield 不回退 content：DB 落库 body 是「→ 交给 xxx」（无来源），历史数据同样缺来源——
  // 统一用 sn（senderName 透出）+ yieldTargets 构造「来源 → 交给 目标」
  if (m.content && t !== 'yield') return m.content
  switch (t) {
    case 'invoke_start': return `🦦 ${name}开始行动～`
    case 'invoke_end': return `🦦 ${name}先休息一下～`
    case 'yield': return `${name} → 交给 ` + (m.yieldTargets?.length ? m.yieldTargets.join('、') : '…')
    default: return m.content || ''
  }
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
  /** F20260908efmd: 该世生效的模型 alias（null = 存量历史数据未快照） */
  modelAlias?: string | null
}

export function mapOtterDTO(dto: OtterDTO): LocalOtter {
  return {
    id: dto.id,
    name: dto.name,
    type: dto.type as 'big' | 'small',
    createdAt: dto.createdAt.split('T')[0],
    role: dto.role ? { name: dto.role.name, resp: dto.role.responsibilities } : undefined,
    parentOtterId: dto.parentOtterId ?? undefined,
    ...(dto.modelAlias !== undefined && { modelAlias: dto.modelAlias }),
    ...(dto.modelIsDefault !== undefined && { modelIsDefault: dto.modelIsDefault }),
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
    // F20260902u5tr：发言石目标透出（信号轨迹判定）
    tsp: dto.tsp,
    src: dto.src as 'web' | 'feishu' | undefined,
    // F-multi-speak-bubble: 历史消息分段数据
    segments: dto.segments,
    // F20260826mwrd C4: 消息关联信号（徽章数据）
    signals: dto.signals?.map(s => ({ ...s })),
    // 多模态 Phase 1：附件透出（仅非空时携带）
    ...(dto.atts && { atts: dto.atts }),
  }
}

/** F20260910ctlv 切换清扫：EntryDTO → LocalMessage（时间线历史数据源）。
 *  entryType 直接携带（speak/user/invoke_start/invoke_end/yield/system），驱动 MessageList 渲染分流；
 *  居中条目（invoke 边界/yield）的 content 用 entry.body（后端已填约定文案）。 */
export function mapEntryDTO(dto: EntryDTO): LocalMessage {
  const isCentered = dto.entryType === 'invoke_start' || dto.entryType === 'invoke_end' || dto.entryType === 'yield'
  return {
    id: dto.id,
    st: dto.senderType ?? (isCentered ? 'system' : 'otter'),
    si: dto.senderId ?? '',
    sn: dto.senderName || undefined,
    content: dto.body ?? '',
    status: dto.status as LocalMessageStatus,
    seq: dto.sequenceNum,
    ts: dto.createdAt,
    dur: null,
    ctx: dto.contextTokens ?? undefined,
    ctxMax: dto.contextTokensMax ?? undefined,
    turnId: dto.turnId,
    src: (dto.source ?? undefined) as 'web' | 'feishu' | undefined,
    entryType: dto.entryType,
    invokeId: dto.invokeId ?? undefined,
    // F20260910ctlv test17：invoke_end 的 metadata.invokeStatus 透出（重试按钮数据源）
    ...(dto.metadata?.invokeStatus === 'failed' || dto.metadata?.invokeStatus === 'aborted' ? { invokeStatus: dto.metadata.invokeStatus } : {}),
    // yieldTargets 双用途：yield 条目的传递目标 + user entry 的发言石目标（传递行数据源）
    yieldTargets: dto.yieldTargets ?? undefined,
  }
}

/** 参与者 DTO → LocalOtter（ParticipantDTO 投影已含 type/roleName/modelAlias） */
export function mapParticipantDTO(p: ParticipantDTO): LocalOtter {
  return {
    id: p.otterId,
    name: p.otterName,
    type: (p.otterType as 'big' | 'small') ?? 'small',
    createdAt: '',
    role: p.roleName ? { name: p.roleName, resp: [] } : undefined,
    ...(p.modelAlias !== undefined && { modelAlias: p.modelAlias }),
    ...(p.modelIsDefault !== undefined && { modelIsDefault: p.modelIsDefault }),
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
    // F20260908efmd: 透传 session 快照的 modelAlias（null = 存量未快照）
    modelAlias: dto.modelAlias,
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
  timeoutMinutes: number | null
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
  status: 'running' | 'completed' | 'failed' | 'skipped'
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
  timeoutMinutes: number | null
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
    timeoutMinutes: dto.timeoutMinutes,
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
    status: dto.status as 'running' | 'completed' | 'failed' | 'skipped',
    errorMessage: dto.errorMessage,
    messageId: dto.messageId,
    turnId: dto.turnId,
  }
}
