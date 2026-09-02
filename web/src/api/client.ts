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
  OtterProfileDTO,
  UploadAttachmentResponseDTO,
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

/** 多模态 Phase 1：附件上传（multipart）——后端返回 { attachments: AttachmentDTO[] }（含服务端分配的 id）。
 *  用原生 fetch 不走 request()：multipart 禁止手动设 Content-Type（boundary 由浏览器生成） */
export function uploadAttachments(conversationId: string, files: File[], uploaderId = 'user'): Promise<UploadAttachmentResponseDTO> {
  const form = new FormData()
  for (const f of files) form.append('files', f, f.name)
  return request(`/conversations/${conversationId}/attachments?uploaderId=${encodeURIComponent(uploaderId)}`, {
    method: 'POST',
    body: form,
    headers: {}, // 覆盖默认 Content-Type，让浏览器带 boundary
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

/** PR-2: Otter 面板 profile（聚合端点） */
export function fetchOtterProfile(otterId: string): Promise<OtterProfileDTO> {
  return request(`/otters/${otterId}/profile`)
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
  scheduleType?: 'cron' | 'once'
  cron?: string
  triggerAt?: string
  timezone?: string
  body: string
  talkingStonePassedTo: string[]
  senderId?: string
  restartBeforeInvoke?: boolean
  timeoutMinutes?: number | null
}

export interface UpdateScheduledTaskRequestDTO {
  name?: string
  cron?: string
  timezone?: string
  body?: string
  /** #610: watchlist-only patch——只替换 body JSON 中的 watchlist 字段，无需携带 prompt 全文。与 body 互斥。 */
  watchlist?: string[]
  talkingStonePassedTo?: string[]
  status?: 'active' | 'disabled' | 'error'
  restartBeforeInvoke?: boolean
  timeoutMinutes?: number | null
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

// ── 微信连接管理（issue #566）──

export interface WeixinLoginSessionDTO {
  id: string
  status: 'pending' | 'waiting_scan' | 'scaned' | 'success' | 'expired' | 'error' | 'cancelled'
  qrcodePng?: string
  qrcodeUrl?: string
  accountId?: string
  ilinkUserId?: string
  error?: string
  createdAt: string
}

export interface WeixinAccountDTO {
  id: string
  ilinkBotId?: string
  ilinkUserId?: string
  addedAt: string
  hasToken: boolean
}

export function startWeixinLogin(): Promise<WeixinLoginSessionDTO> {
  return request('/weixin/login', { method: 'POST' })
}

export function getWeixinLogin(id: string): Promise<WeixinLoginSessionDTO> {
  return request(`/weixin/login/${id}`)
}

export function cancelWeixinLogin(id: string): Promise<{ status: string }> {
  return request(`/weixin/login/${id}/cancel`, { method: 'POST' })
}

export function listWeixinAccounts(): Promise<WeixinAccountDTO[]> {
  return request('/weixin/accounts')
}

export function deleteWeixinAccount(id: string): Promise<{ status: string }> {
  return request(`/weixin/accounts/${id}`, { method: 'DELETE' })
}

// ── RHI 健康面板（F20260825rweb #402/#403；F20260829hviz 增补 trends）──

export interface RhiOverviewDTO {
  metrics: Record<string, number>
  snapshotDate: string | null
  openSignals: number
  openSignalsBySeverity: { critical: number; warning: number }
  /** Issue #652：按置信度计数（low = 低置信折叠抽屉数据源，不进 severity 主数） */
  openSignalsByConfidence: { normal: number; low: number }
}

export interface RhiTrendPointDTO {
  date: string
  total_commits?: number
  bugfix_count?: number
  bugfix_ratio?: number
  compliant_commits?: number
}

export interface RhiTrendsDTO {
  days: number
  series: RhiTrendPointDTO[]
  distributions: {
    change_types?: Record<string, number>
    skip_reasons?: Record<string, number>
    modules?: Array<{ module: string; count: number }>
    file_hotspots?: Array<{ file: string; count: number }>
    chain_states?: Record<string, number>
  }
  latestSnapshotDate: string | null
}

export interface RhiSignalDTO {
  id: number
  signal_type: string
  severity: string
  feature_id: string | null
  file_path: string | null
  evidence: string
  first_seen: string
  last_seen: string
  occurrences: number
  status: string
  suggested_action: string | null
  signalTypeLabel: string
  /** Issue #644：结构化证据详情（bug●→fix● 交替时间轴数据源）。null=无 */
  evidenceDetail: {
    kind: string
    windowDays: number
    commits: Array<{ sha: string; date: string; changeType: string | null; message: string }>
  } | null
  /** 置信度：low=大概率误报（UI 折叠收纳）。null=normal */
  confidence: string | null
}

export interface RhiChainCommitLiteDTO {
  /** 8 位短 sha */
  sha: string
  /** ISO 时间 */
  date: string
  changeType: string | null
}

export interface RhiChainDTO {
  featureId: string
  state: 'active' | 'stalled' | 'regressed' | 'zombie' | 'orphan'
  commitCount: number
  bugfixCount: number
  daysSinceLastCommit: number | null
  firstSeenAt: string | null
  lastCommitAt: string | null
  docStatus: string | null
  docTitle: string | null
  stateReason: string
  /** Issue #649 PR3：轻量 commit 序列（泳道 x 轴映射；全量含 message/filesChanged 走 chainDetail） */
  commits: RhiChainCommitLiteDTO[]
}

export function getRhiOverview(signal?: AbortSignal): Promise<RhiOverviewDTO> {
  return request('/health/overview', { signal })
}

export function getRhiSignals(status = 'open', signal?: AbortSignal): Promise<{ signals: RhiSignalDTO[]; count: number }> {
  return request(`/health/signals?status=${encodeURIComponent(status)}`, { signal })
}

export function getRhiChains(signal?: AbortSignal): Promise<{ chains: RhiChainDTO[]; stateCounts: Record<string, number>; total: number; fanInExcludedFiles: Array<{ file: string; fanIn: number }> }> {
  return request('/health/chains', { signal })
}

/** Issue #644：链详情（全类型 commit 序列——泳道时间线/链详情抽屉数据源） */
export interface RhiChainDetailCommitDTO {
  sha: string
  date: string
  changeType: string | null
  message: string
  filesChanged: string[]
}

export interface RhiChainDetailDTO extends Omit<RhiChainDTO, 'commits'> {
  commits: RhiChainDetailCommitDTO[]
}

export function getRhiChainDetail(featureId: string, signal?: AbortSignal): Promise<{ chain: RhiChainDetailDTO }> {
  return request(`/health/chains/${encodeURIComponent(featureId)}`, { signal })
}

export function getRhiTrends(days = 30, signal?: AbortSignal): Promise<RhiTrendsDTO> {
  return request(`/health/trends?days=${days}`, { signal })
}

/** #581：扫描失败时后端返回 500，request() 抛 ApiError——响应体不再有 ok:false 分支 */
export function triggerRhiScan(): Promise<{ result: Record<string, unknown> }> {
  return request('/health/scan', { method: 'POST' })
}

export interface RhiCostOutputTrendPointDTO {
  date: string
  totalTokens: number
  costTotal: number
  callCount: number
  cacheHitRate: number
  messageCount: number
}

export interface RhiCostOutputOtterDTO {
  otterId: string
  otterName: string
  otterType: string
  totalTokens: number
  costTotal: number
  callCount: number
  cacheHitRate: number
  messageCount: number
  models: Array<{ model: string; totalTokens: number; costTotal: number }>
}

export interface RhiCostOutputDTO {
  days: number
  series: RhiCostOutputTrendPointDTO[]
  otters: RhiCostOutputOtterDTO[]
  totals: {
    totalTokens: number
    costTotal: number
    callCount: number
    messageCount: number
    otterCount: number
    dispatchCount: number
  }
  latestSnapshotDate: string | null
}

export function getRhiCostOutput(days = 30, includeAllOtters = false, signal?: AbortSignal): Promise<RhiCostOutputDTO> {
  return request(`/health/cost-output?days=${days}&includeAllOtters=${includeAllOtters}`, { signal })
}

/** F20260830xxxx：健康评分 DTO（GET /api/health/score，issue #595 PR2）*/
export interface RhiScoreDimensionDTO {
  dimension: 'D1' | 'D2' | 'D3' | 'D4' | 'D5'
  name: string
  score: number | null
  status: 'green' | 'yellow' | 'red' | null
}

export interface RhiScoreDTO {
  available: boolean
  snapshotDate: string | null
  overall: number | null
  overallStatus: 'green' | 'yellow' | 'red' | null
  dimensions: RhiScoreDimensionDTO[]
  /** 后端 TrendDirection：improving/stable/declining；不足 8 数据点为 null */
  trend: Partial<Record<string, 'improving' | 'stable' | 'declining' | null>>
  attribution: string | null
}

export function getRhiScore(signal?: AbortSignal): Promise<RhiScoreDTO> {
  return request('/health/score', { signal })
}

// ── 通道状态（F20260901chun：统一 IM 页 + 真实健康状态）──

export interface ChannelStatusDTO {
  channelId: string;
  kind: "weixin" | "feishu";
  state: {
    kind: string;
    since: number;
    lastInboundAt?: number;
    degraded?: boolean;
    errmsg?: string;
    errorMsg?: string;
    nextRetryAt?: number;
    reason?: string;
    /** #663：连续重连次数（飞书长连接 error_backoff 时携带，成功归零） */
    reconnectAttempts?: number;
  };
  account?: { id: string; nickname?: string };
  /** #663：掩码后的飞书 app_id（凭证确认用，形如 cli_a****z9k2） */
  appIdMasked?: string;
}

export interface ChannelStatusResponseDTO {
  channels: ChannelStatusDTO[];
}

export function getChannelStatus(): Promise<ChannelStatusResponseDTO> {
  return request('/channels/status')
}
