/**
 * RHI 健康面板 API 契约（Issue #448）。
 *
 * signals/overview/trends(chains) 端点命名统一 camelCase，DTO 单一真相源在此
 * （前端原手写定义绕过契约层，本文件收口——client.ts re-export）。
 * 字段集与迁移前保持一致（YAGNI：字段量级调整不在 #448 范围）。
 */

// ── signals：GET /api/health/signals?status=open|all|... ──

export interface RhiSignalEvidenceDetailCommitsDTO {
  sha: string
  date: string
  changeType: string | null
  message: string
}

export interface RhiSignalEvidenceDetailDTO {
  kind: string
  windowDays: number
  commits: RhiSignalEvidenceDetailCommitsDTO[]
}

export interface RhiSignalDTO {
  id: number
  signalType: string
  severity: string
  featureId: string | null
  filePath: string | null
  evidence: string
  firstSeen: string
  lastSeen: string
  occurrences: number
  status: string
  suggestedAction: string | null
  /** 信号中文名（后端 SIGNAL_REGISTRY 单一真相源，#715/#717） */
  signalTypeLabel: string
  /** Issue #644：结构化证据详情（bug●→fix● 交替时间轴数据源）。null=无（解析降级） */
  evidenceDetail: RhiSignalEvidenceDetailDTO | null
  /** 置信度：low=大概率误报（UI 折叠收纳）。null=normal */
  confidence: string | null
  /** F20260917trig：处置状态机——null=未接单；'triaged'=已归口；'in_progress'=修复中 */
  triageStatus: string | null
  /** F20260917trig：绑定的 GitHub issue 编号 */
  issueNumber: number | null
  /** F20260917trig：归口时间（ISO） */
  triagedAt: string | null
  /** F20260917trig：处置说明 */
  triageNote: string | null
}

// ── overview：GET /api/health/overview ──

export interface RhiOverviewDTO {
  /** 指标键 camelCase（DB 存储键 snake_case 的序列化投影）：totalCommits / commitsWithFid / compliantCommits / skippedCommits / bugfixCount / bugfixRatio / bugfixRatioOfFid */
  metrics: Record<string, number>
  snapshotDate: string | null
  openSignals: number
  openSignalsBySeverity: { critical: number; warning: number }
  /** Issue #652：按置信度计数（low = 低置信折叠抽屉数据源，不进 severity 主数） */
  openSignalsByConfidence: { normal: number; low: number }
}

// ── trends：GET /api/health/trends?days=30 ──

export interface RhiTrendPointDTO {
  date: string
  totalCommits?: number
  bugfixCount?: number
  bugfixRatio?: number
  compliantCommits?: number
}

export interface RhiTrendsDistributionsDTO {
  changeTypes?: Record<string, number>
  skipReasons?: Record<string, number>
  modules?: Array<{ module: string; count: number }>
  fileHotspots?: Array<{ file: string; count: number }>
  chainStates?: Record<string, number>
}

export interface RhiTrendsDTO {
  days: number
  series: RhiTrendPointDTO[]
  distributions: RhiTrendsDistributionsDTO
  latestSnapshotDate: string | null
}

// ── chains：GET /api/health/chains 与 /api/health/chains/:featureId ──

export interface RhiChainCommitLiteDTO {
  /** 8 位短 sha */
  sha: string
  /** ISO 时间 */
  date: string
  changeType: string | null
}

export interface RhiChainDTO {
  featureId: string
  /** F20260902sigm：四态兼容投影（zombie 删除） */
  state: 'active' | 'stalled' | 'regressed' | 'orphan'
  /** 链路信号清单（可叠加；state 是其兼容投影） */
  signals: Array<{
    id: 'pr-stalled' | 'regressed' | 'doc-gap'
    evidence: string
    stalledPrs?: Array<{ number: number; url: string | null; daysSinceActivity: number }>
  }>
  commitCount: number
  bugfixCount: number
  daysSinceLastCommit: number | null
  firstSeenAt: string | null
  lastCommitAt: string | null
  /** deprecated：健康链路不再消费（F20260902sigm），存量兼容保留 */
  docStatus: string | null
  docTitle: string | null
  stateReason: string
  /** Issue #649 PR3：轻量 commit 序列（泳道 x 轴映射；全量含 message/filesChanged 走 chainDetail） */
  commits: RhiChainCommitLiteDTO[]
}

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
