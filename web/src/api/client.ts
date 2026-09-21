import type {
  ConversationDTO,
  ConversationListItemDTO,
  CreateConversationRequestDTO,
  UnreadStateDTO,
  MarkReadResponseDTO,
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
  InvokeListResponseDTO,
  InvokeEventsResponseDTO,
  EntriesResponseDTO,
  HealingEventsResponseDTO,
  SignalEventsResponseDTO,
  DispatchRecordsResponseDTO,
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

export function listConversations(options?: { limit?: number; offset?: number; search?: string }): Promise<ConversationListItemDTO[]> {
  const qs = new URLSearchParams();
  if (options?.limit) qs.set('limit', String(options.limit));
  if (options?.offset) qs.set('offset', String(options.offset));
  if (options?.search) qs.set('search', options.search);
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

// ── Messages（F20260913ctlv 彻底切换：只保留发言/未读/已读，历史读取/事件/中止/重试已迁 entries+invokes）──

/** 未读状态 */
export function getUnreadState(conversationId: string): Promise<UnreadStateDTO> {
  return request(`/conversations/${conversationId}/unread`)
}

/** 标记已读 */
export function markRead(conversationId: string, messageSeq: number): Promise<MarkReadResponseDTO> {
  return request(`/conversations/${conversationId}/read`, { method: 'POST', body: JSON.stringify({ messageSeq }) })
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

// ── Invokes（F20260913ctlv：Session 弹窗 + 獭状态面板数据源）──

/** 拉取会话内 invoke 记录列表（before 游标分页，otterId 可选过滤单獭） */
export function listInvokes(conversationId: string, options?: { limit?: number; before?: string; otterId?: string }): Promise<InvokeListResponseDTO> {
  const qs = new URLSearchParams({ limit: String(options?.limit ?? 50) })
  if (options?.before) qs.set('before', options.before)
  if (options?.otterId) qs.set('otterId', options.otterId)
  return request(`/conversations/${conversationId}/invokes?${qs}`)
}

/** 拉取单次 invoke 的全部流式过程事件（Session 弹窗展开态数据源） */
export function getInvokeEvents(invokeId: string): Promise<InvokeEventsResponseDTO> {
  return request(`/invokes/${invokeId}/events`)
}

/** F20260913ctlv 切换清扫：拉取会话时间线条目（entries 历史数据源，替代 messages 渲染路径） */
export function listEntries(conversationId: string, limit = 50, before?: string): Promise<EntriesResponseDTO> {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (before) qs.set('before', before)
  return request(`/conversations/${conversationId}/entries?${qs}`)
}

/** F20260913ctlv 彻底切换：after 游标向下分页（增量刷新用，升序） */
export function listEntriesAfter(conversationId: string, after: string, limit = 100): Promise<EntriesResponseDTO> {
  const qs = new URLSearchParams({ limit: String(limit), after })
  return request(`/conversations/${conversationId}/entries?${qs}`)
}

/** F20260913ctlv 彻底切换：中止运行中 invoke（Session 弹窗/右栏停止按钮） */
export function abortInvoke(invokeId: string, otterId: string): Promise<{ status: string }> {
  return request(`/invokes/${invokeId}/abort`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otterId }),
  })
}

/** F20260913ctlv 彻底切换：重试失败 invoke（前端气泡重试按钮；返回 SSE 流） */
export function retryInvoke(invokeId: string): Promise<Response> {
  return fetch(`${BASE}/invokes/${invokeId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}

/** F20260913ctlv test17（搭档拍板）：獭锚重试——重试的是獭的 session（上下文载体），
 *  invoke 只是执行记录。右栏重试按钮用此（无需 invokeId，天然避开 otterId/invokeId 错位坑） */
export function retryOtter(otterId: string, conversationId: string): Promise<Response> {
  return fetch(`${BASE}/otters/${otterId}/retry?conversationId=${encodeURIComponent(conversationId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Otters ──

export function getOtter(id: string): Promise<OtterDTO> {
  return request(`/otters/${id}`)
}

/** F20260921otcl：conversationId 走 query 注入（出生挑色域——服务端 controller 层读取） */
export function createOtter(body: CreateOtterRequestDTO, conversationId?: string): Promise<OtterDTO> {
  const qs = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''
  return request(`/otters${qs}`, { method: 'POST', body: JSON.stringify(body) })
}

export function dissolveOtter(id: string, summary?: string): Promise<{ status: string }> {
  return request(`/otters/${id}`, { method: 'DELETE', body: summary ? JSON.stringify({ summary }) : undefined })
}

export function getSessionHistory(otterId: string): Promise<OtterSessionDTO[]> {
  return request(`/otters/${otterId}/sessions`)
}

/** F20260920uhuc：synthesizePast（缺省 true=后台由引擎合成前世叙事档案；false=仅自总结+机械档案） */
export function restartOtter(otterId: string, summary?: string, modelAlias?: string, synthesizePast?: boolean): Promise<OtterSessionDTO> {
  const body: { summary?: string; modelAlias?: string; synthesizePast?: boolean } = {}
  if (summary) body.summary = summary
  if (modelAlias) body.modelAlias = modelAlias
  if (synthesizePast === false) body.synthesizePast = false // 仅显式 false 下发——缺省 true 向后兼容旧后端
  return request(`/otters/${otterId}/restart`, { method: 'POST', body: Object.keys(body).length ? JSON.stringify(body) : undefined })
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

/** #576（F20260901emps）：最近记忆——记忆搜索页初始态数据源 */
export function getRecentMemory(limit = 10): Promise<{ entries: MemoryEntryDTO[]; total: number }> {
  return request(`/memory/recent?limit=${limit}`)
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
  /** F20260915desc: 人类可读任务描述（可选） */
  description?: string | null
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
  /** F20260915desc: 任务描述。传 null 清除 */
  description?: string | null
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
  /** F20260915desc: 人类可读任务描述（未设置为 null，前端回退渲染 body） */
  description: string | null
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

export interface EnterConversationRequestDTO {
  conversationId: string
}

export function getConnection(id: string): Promise<ConnectionDTO> {
  return request(`/connections/${id}`)
}

export function enterConversation(connectionId: string, body: EnterConversationRequestDTO): Promise<ConnectionSessionDTO> {
  return request(`/connections/${connectionId}/enter`, { method: 'POST', body: JSON.stringify(body) })
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
  /** F20260921imux：助理线投影（账号→活跃对话绑定；后端真相源，取代前端 title 启发式） */
  assistantLine?: { conversationId: string }
}

/** F20260921imux：同号识别（扫码前/后探测已有账号）。
 *  预留：扫码前预探测场景；当前前端走列表本地匹配，暂未消费（检视 D2 标注） */
export function lookupWeixinAccount(ilinkUserId: string): Promise<{ account?: { id: string; assistantLine?: { conversationId: string } } }> {
  return request('/weixin/accounts/lookup', { method: 'POST', body: JSON.stringify({ ilinkUserId }) })
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

/** F20260920imax：扫码登录后按名建助理线（名字必填） */
export function provisionWeixinAssistantLine(accountId: string, name: string): Promise<{ conversationId: string; title: string }> {
  return request(`/weixin/accounts/${accountId}/assistant-line`, { method: 'POST', body: JSON.stringify({ name }) })
}

export function deleteWeixinAccount(id: string): Promise<{ status: string }> {
  return request(`/weixin/accounts/${id}`, { method: 'DELETE' })
}

// ── RHI 健康面板（F20260825rweb #402/#403；F20260829hviz 增补 trends）──
// Issue #448：DTO 单一真相源收口到 @contract/api/rhi——以下均为契约层 re-export
export type {
  RhiSignalDTO,
  RhiSignalEvidenceDetailDTO,
  RhiSignalEvidenceDetailCommitsDTO,
  RhiOverviewDTO,
  RhiTrendPointDTO,
  RhiTrendsDTO,
  RhiTrendsDistributionsDTO,
  RhiChainDTO,
  RhiChainCommitLiteDTO,
  RhiChainDetailDTO,
  RhiChainDetailCommitDTO,
} from '@contract/api/rhi'
import type { RhiSignalDTO, RhiOverviewDTO, RhiChainDTO, RhiChainDetailDTO, RhiTrendsDTO } from '@contract/api/rhi'

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

/** F20260917trig：面板处置队列写路径（与 agent 工具 triage_signal 共享 repo.triage() 单一方法） */
export function triageRhiSignal(
  id: number,
  body: { action: 'bind_issue' | 'in_progress' | 'dismiss'; issueNumber?: number; note?: string },
): Promise<{ ok: boolean; record: RhiSignalDTO }> {
  return request(`/health/signals/${id}/triage`, { method: 'POST', body: JSON.stringify(body) })
}

export interface RhiCostOutputTrendPointDTO {
  date: string
  totalTokens: number
  callCount: number
  errorCalls: number
  cacheHitRate: number
  messageCount: number
}

/** F20260914usgm：per-model 汇总（面板主维度） */
export interface RhiModelUsageDTO {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  callCount: number
  errorCalls: number
  cacheHitRate: number
}

/** F20260914usgm：单次问答均值（per-model + _total） */
export interface RhiInvokeStatsDTO {
  model: string
  invokeCount: number
  avgToolCalls: number
  avgDurationSec: number
  avgInputTokens: number
  avgOutputTokens: number
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
  models: RhiModelUsageDTO[]
  invokeStats: RhiInvokeStatsDTO[]
  otters: RhiCostOutputOtterDTO[]
  totals: {
    totalTokens: number
    callCount: number
    errorCalls: number
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

// ── 活动页三域台账（F20260912avlb，全只读）──

/** healing 事件列表（status 默认 open） */
export function getActivityHealing(params?: { status?: string; errorType?: string; conversationId?: string; limit?: number }, signal?: AbortSignal): Promise<HealingEventsResponseDTO> {
  const q = new URLSearchParams()
  if (params?.status) q.set('status', params.status)
  if (params?.errorType) q.set('errorType', params.errorType)
  if (params?.conversationId) q.set('conversationId', params.conversationId)
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return request(`/activity/healing${qs ? `?${qs}` : ''}`, { signal })
}

/** 獭间信号列表 */
export function getActivitySignals(params?: { status?: string; type?: string; limit?: number }, signal?: AbortSignal): Promise<SignalEventsResponseDTO> {
  const q = new URLSearchParams()
  if (params?.status) q.set('status', params.status)
  if (params?.type) q.set('type', params.type)
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return request(`/activity/signals${qs ? `?${qs}` : ''}`, { signal })
}

/** 派工台账列表 */
export function getActivityDispatch(params?: { conversationId?: string; status?: string; limit?: number }, signal?: AbortSignal): Promise<DispatchRecordsResponseDTO> {
  const q = new URLSearchParams()
  if (params?.conversationId) q.set('conversationId', params.conversationId)
  if (params?.status) q.set('status', params.status)
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return request(`/activity/dispatch${qs ? `?${qs}` : ''}`, { signal })
}
