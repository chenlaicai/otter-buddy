import type {
  ConversationDTO,
  ConversationListItemDTO,
  CreateConversationRequestDTO,
  MessageDTO,
  MessageListResponseDTO,
  UnreadStateDTO,
  MarkReadResponseDTO,
  MessageEventDTO,
  SendMessageRequestDTO,
  OtterDTO,
  CreateOtterRequestDTO,
  OtterSessionDTO,
  SearchResultDTO,
  MemoryEntryDTO,
  KeyInfoDTO,
  SettingsDTO,
  UpdateSettingsRequestDTO,
  LinkedResourceDTO,
  ParticipantDTO,
} from '@contract/api'

const BASE = '/api'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(body.error ?? res.statusText, res.status)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

// ── Conversations ──

export function listConversations(options?: { limit?: number; offset?: number }): Promise<ConversationListItemDTO[]> {
  const qs = new URLSearchParams();
  if (options?.limit) qs.set('limit', String(options.limit));
  if (options?.offset) qs.set('offset', String(options.offset));
  return request(`/conversations?${qs}`)
}

export function createConversation(body: CreateConversationRequestDTO): Promise<ConversationDTO> {
  return request('/conversations', { method: 'POST', body: JSON.stringify(body) })
}

export function getConversation(id: string): Promise<ConversationDTO> {
  return request(`/conversations/${id}`)
}

export function archiveConversation(id: string): Promise<{ status: string }> {
  return request(`/conversations/${id}/archive`, { method: 'PATCH' })
}

export function pinConversation(id: string): Promise<{ status: string }> {
  return request(`/conversations/${id}/pin`, { method: 'PATCH' })
}

export function unpinConversation(id: string): Promise<{ status: string }> {
  return request(`/conversations/${id}/unpin`, { method: 'PATCH' })
}

export function getParticipants(conversationId: string): Promise<ParticipantDTO[]> {
  return request(`/conversations/${conversationId}/participants`)
}

// ── Messages ──

export function listMessages(conversationId: string, limit = 50, before?: string): Promise<MessageListResponseDTO> {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (before) qs.set('before', before)
  return request(`/conversations/${conversationId}/messages?${qs}`)
}

/** after 游标向下分页（加载比 after 消息更新的历史消息） */
export function listMessagesAfter(conversationId: string, after: string, limit = 50): Promise<MessageListResponseDTO> {
  const qs = new URLSearchParams({ after, limit: String(limit) })
  return request(`/conversations/${conversationId}/messages/after?${qs}`)
}

/** 未读状态 */
export function getUnreadState(conversationId: string): Promise<UnreadStateDTO> {
  return request(`/conversations/${conversationId}/unread`)
}

/** 标记已读 */
export function markRead(conversationId: string, messageSeq: number): Promise<MarkReadResponseDTO> {
  return request(`/conversations/${conversationId}/read`, { method: 'POST', body: JSON.stringify({ messageSeq }) })
}

/** 加载目标消息上下文（搜索跳转 / 未读窗口加载） */
export function expandMessage(messageId: string, direction: 'before' | 'after' | 'both' = 'both', count = 25): Promise<MessageDTO[]> {
  const qs = new URLSearchParams({ direction, count: String(count) })
  return request(`/messages/${messageId}/expand?${qs}`)
}

export function getMessageEvents(messageId: string): Promise<MessageEventDTO[]> {
  return request(`/messages/${messageId}/events`)
}

export function getMessage(messageId: string): Promise<MessageDTO> {
  return request(`/messages/${messageId}`)
}

export function sendMessage(conversationId: string, body: SendMessageRequestDTO): Promise<Response> {
  return fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function abortMessage(messageId: string): Promise<{ status: string }> {
  return request(`/messages/${messageId}/abort`, { method: 'POST' })
}

export function retryMessage(messageId: string): Promise<Response> {
  return fetch(`${BASE}/messages/${messageId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Otters ──

export function getOtter(id: string): Promise<OtterDTO> {
  return request(`/otters/${id}`)
}

export function createOtter(body: CreateOtterRequestDTO): Promise<OtterDTO> {
  return request('/otters', { method: 'POST', body: JSON.stringify(body) })
}

export function dissolveOtter(id: string, summary?: string): Promise<{ status: string }> {
  return request(`/otters/${id}`, { method: 'DELETE', body: summary ? JSON.stringify({ summary }) : undefined })
}

export function getSessionHistory(otterId: string): Promise<OtterSessionDTO[]> {
  return request(`/otters/${otterId}/sessions`)
}

export function restartOtter(otterId: string, summary?: string): Promise<OtterSessionDTO> {
  return request(`/otters/${otterId}/restart`, { method: 'POST', body: summary ? JSON.stringify({ summary }) : undefined })
}

// ── Key Resources ──

export function getKeyResources(conversationId: string): Promise<KeyInfoDTO> {
  return request(`/conversations/${conversationId}/key-resources`)
}

export function linkResource(conversationId: string, body: { resourceType: string; url?: string; title?: string; content?: string; category?: string; linkedBy: string; otterId?: string; autoLinked: boolean }): Promise<LinkedResourceDTO> {
  return request(`/conversations/${conversationId}/resources`, { method: 'POST', body: JSON.stringify(body) })
}

export function flagResource(conversationId: string, resourceId: string, flagged: boolean): Promise<{ status: string }> {
  return request(`/conversations/${conversationId}/resources/${resourceId}`, { method: 'PATCH', body: JSON.stringify({ flagged }) })
}

export function deleteLinkedResource(conversationId: string, resourceId: string): Promise<void> {
  return request(`/conversations/${conversationId}/resources/${resourceId}`, { method: 'DELETE' })
}

// ── Memory ──

export function searchMemory(params: {
  query: string;
  limit?: number;
  layer?: string;
  granularity?: string;
  conversationId?: string;
  detail_level?: 'summary' | 'snippet' | 'full';
  library?: string;
}): Promise<SearchResultDTO> {
  const qs = new URLSearchParams()
  qs.set('query', params.query)
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.layer) qs.set('layer', params.layer)
  if (params.granularity) qs.set('granularity', params.granularity)
  if (params.conversationId) qs.set('conversationId', params.conversationId)
  if (params.detail_level) qs.set('detail_level', params.detail_level)
  if (params.library) qs.set('library', params.library)
  return request(`/memory/search?${qs}`)
}

export function getMemoryById(id: string): Promise<MemoryEntryDTO> {
  return request(`/memory/${id}`)
}

export function searchSimilar(memoryEntryId: string, limit = 10): Promise<SearchResultDTO> {
  return request('/memory/search/similar', {
    method: 'POST',
    body: JSON.stringify({ memoryEntryId, limit }),
  })
}

// ── Health (F20260803mval) ──

export interface MemoryGapReason {
  id: string
  file: string
  errors: string[]
}

export interface MemoryHealthDTO {
  healthy: boolean
  documentsOnDisk: number
  documentsInDb: number
  reconcileGaps: string[]
  /** F20260804dcnv: 每个 gap 文档的 validator 失败原因，让 banner 直接显示根因 */
  gapReasons?: MemoryGapReason[]
  embeddingAvailable: boolean
  embeddingModel: string
  error?: string
}

export function getMemoryHealth(): Promise<MemoryHealthDTO> {
  return request('/health/memory')
}

export function flagMemory(id: string, flagged: boolean): Promise<{ status: string }> {
  return request(`/memory/${id}/flag`, { method: 'PATCH', body: JSON.stringify({ flagged }) })
}

// ── Settings ──

export function getSettings(): Promise<SettingsDTO> {
  return request('/settings')
}

export function updateSettings(body: UpdateSettingsRequestDTO): Promise<SettingsDTO> {
  return request('/settings', { method: 'PUT', body: JSON.stringify(body) })
}

// ── Scheduled Tasks ──

export interface CreateScheduledTaskRequestDTO {
  name: string
  cron: string
  timezone?: string
  body: string
  talkingStonePassedTo: string[]
  senderId?: string
}

export interface UpdateScheduledTaskRequestDTO {
  name?: string
  cron?: string
  timezone?: string
  body?: string
  talkingStonePassedTo?: string[]
  status?: 'active' | 'disabled' | 'error'
}

export interface ScheduledTaskDTO {
  id: string
  conversationId: string
  name: string
  cron: string
  timezone: string
  body: string
  talkingStonePassedTo: string[]
  senderId: string
  status: string
  consecutiveFailures: number
  lastTriggeredAt: string | null
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

export function listScheduledTasks(conversationId: string): Promise<ScheduledTaskDTO[]> {
  return request(`/conversations/${conversationId}/scheduled-tasks`)
}

export function createScheduledTask(conversationId: string, body: CreateScheduledTaskRequestDTO): Promise<ScheduledTaskDTO> {
  return request(`/conversations/${conversationId}/scheduled-tasks`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function getScheduledTask(taskId: string): Promise<ScheduledTaskDTO> {
  return request(`/scheduled-tasks/${taskId}`)
}

export function updateScheduledTask(taskId: string, body: UpdateScheduledTaskRequestDTO): Promise<ScheduledTaskDTO> {
  return request(`/scheduled-tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteScheduledTask(taskId: string): Promise<void> {
  return request(`/scheduled-tasks/${taskId}`, { method: 'DELETE' })
}

export function triggerScheduledTask(taskId: string): Promise<{ executionId: string }> {
  return request(`/scheduled-tasks/${taskId}/trigger`, { method: 'POST' })
}

export function listExecutions(taskId: string, options?: { limit?: number; offset?: number }): Promise<{ executions: ScheduledTaskExecutionDTO[]; total: number; limit: number; offset: number }> {
  const qs = new URLSearchParams()
  if (options?.limit) qs.set('limit', String(options.limit))
  if (options?.offset) qs.set('offset', String(options.offset))
  return request(`/scheduled-tasks/${taskId}/executions?${qs}`)
}

// ── Connections (IM 大厅) ──

export interface ConnectionDTO {
  id: string
  name: string
  externalId: string
  externalType: string
  metadata: Record<string, unknown> | null
  status: string
  createdAt: string
  updatedAt: string
}

export interface ConnectionSessionDTO {
  id: string
  connectionId: string
  conversationId: string
  status: string
  joinedAt: string
  releasedAt: string | null
}

export interface CreateConnectionRequestDTO {
  name: string
  externalId: string
}

export interface EnterConversationRequestDTO {
  conversationId: string
}

export function listConnections(): Promise<ConnectionDTO[]> {
  return request('/connections')
}

export function createConnection(body: CreateConnectionRequestDTO): Promise<ConnectionDTO> {
  return request('/connections', { method: 'POST', body: JSON.stringify(body) })
}

export function getConnection(id: string): Promise<ConnectionDTO> {
  return request(`/connections/${id}`)
}

export function getConnectionSession(id: string): Promise<{ id: string; title: string } | null> {
  return request(`/connections/${id}/session`)
}

export function enterConversation(connectionId: string, body: EnterConversationRequestDTO): Promise<ConnectionSessionDTO> {
  return request(`/connections/${connectionId}/enter`, { method: 'POST', body: JSON.stringify(body) })
}

export function leaveConversation(connectionId: string): Promise<{ status: string }> {
  return request(`/connections/${connectionId}/leave`, { method: 'POST' })
}

export function listActiveConversations(): Promise<Array<{ id: string; title: string; occupiedBy?: string }>> {
  return request('/connections/any/conversations')
}
