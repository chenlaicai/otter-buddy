import type {
  ConversationDTO,
  ConversationListItemDTO,
  CreateConversationRequestDTO,
  MessageDTO,
  SendMessageRequestDTO,
  OtterDTO,
  CreateOtterRequestDTO,
  OtterSessionDTO,
  SearchResultDTO,
  KeyInfoDTO,
  SettingsDTO,
  UpdateSettingsRequestDTO,
  LinkedResourceDTO,
  ParticipantDTO,
} from '@contract/api'

const BASE = '/api'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

// ── Conversations ──

export function listConversations(): Promise<ConversationListItemDTO[]> {
  return request('/conversations')
}

export function createConversation(body: CreateConversationRequestDTO): Promise<ConversationDTO> {
  return request('/conversations', { method: 'POST', body: JSON.stringify(body) })
}

export function getConversation(id: string): Promise<ConversationDTO> {
  return request(`/conversations/${id}`)
}

export function completeConversation(id: string): Promise<{ status: string }> {
  return request(`/conversations/${id}/complete`, { method: 'PATCH' })
}

export function archiveConversation(id: string): Promise<{ status: string }> {
  return request(`/conversations/${id}/archive`, { method: 'PATCH' })
}

export function getParticipants(conversationId: string): Promise<ParticipantDTO[]> {
  return request(`/conversations/${conversationId}/participants`)
}

// ── Messages ──

export function listMessages(conversationId: string, limit = 50): Promise<MessageDTO[]> {
  return request(`/conversations/${conversationId}/messages?limit=${limit}`)
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

export function createSession(otterId: string): Promise<OtterSessionDTO> {
  return request(`/otters/${otterId}/sessions`, { method: 'POST' })
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

export function searchMemory(params: { query: string; limit?: number; layer?: string; granularity?: string; conversationId?: string }): Promise<SearchResultDTO> {
  const qs = new URLSearchParams()
  qs.set('query', params.query)
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.layer) qs.set('layer', params.layer)
  if (params.granularity) qs.set('granularity', params.granularity)
  if (params.conversationId) qs.set('conversationId', params.conversationId)
  return request(`/memory/search?${qs}`)
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
