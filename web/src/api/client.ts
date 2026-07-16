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
  KeyFactDTO,
  LinkedResourceDTO,
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

export function listConversations(otterId: string): Promise<ConversationListItemDTO[]> {
  return request(`/conversations?otterId=${encodeURIComponent(otterId)}`)
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

export function getBigOtter(): Promise<OtterDTO> {
  return request('/otters/big')
}

export function getOtter(id: string): Promise<OtterDTO> {
  return request(`/otters/${id}`)
}

export function createOtter(body: CreateOtterRequestDTO): Promise<OtterDTO> {
  return request('/otters', { method: 'POST', body: JSON.stringify(body) })
}

export function dissolveOtter(id: string): Promise<{ status: string }> {
  return request(`/otters/${id}`, { method: 'DELETE' })
}

export function getSessionHistory(otterId: string): Promise<OtterSessionDTO[]> {
  return request(`/otters/${otterId}/sessions`)
}

export function createSession(otterId: string): Promise<OtterSessionDTO> {
  return request(`/otters/${otterId}/sessions`, { method: 'POST' })
}

export function restartOtter(otterId: string): Promise<OtterSessionDTO> {
  return request(`/otters/${otterId}/restart`, { method: 'POST' })
}

// ── Key Info ──

export function getKeyInfo(conversationId: string): Promise<KeyInfoDTO> {
  return request(`/conversations/${conversationId}/key-info`)
}

export function addKeyFact(conversationId: string, body: { content: string; category?: string; createdBy: string; otterId?: string }): Promise<KeyFactDTO> {
  return request(`/conversations/${conversationId}/key-facts`, { method: 'POST', body: JSON.stringify(body) })
}

export function linkResource(conversationId: string, body: { resourceType: string; url: string; title?: string; linkedBy: string; otterId?: string; autoLinked: boolean }): Promise<LinkedResourceDTO> {
  return request(`/conversations/${conversationId}/resources`, { method: 'POST', body: JSON.stringify(body) })
}

export function deleteKeyFact(conversationId: string, factId: string): Promise<void> {
  return request(`/conversations/${conversationId}/key-facts/${factId}`, { method: 'DELETE' })
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
