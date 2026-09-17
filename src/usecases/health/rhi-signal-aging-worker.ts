/**
 * RHI 信号老化扫描（F20260917trig §3）。
 *
 * 现场事故：40 条 critical bug_recurrence 信号最老挂 23 天（2026-08-25 first_seen），
 * 已全部聚入 issue #1012 但 issue 仍 open——RHI 信号池（signals 表）无任何老化/升级机制，
 * 挂 23 天系统不觉得疼。獭间信号（signal_events）已有 SignalAgingWorker（#927），
 * RHI 信号量级是它的几十倍（8 种检测类型 × 多文件），不共享代码但复刻其模式。
 *
 * 扫描范围（status='open'）：
 * - 未接单（triage_status IS NULL）：critical 超 72h / warning 超 7d（从 first_seen 计）
 * - 已归口停滞（triage_status='triaged' 且 triaged_at 超 7 天）——一期纳入（S3 处置收紧），
 *   「每日 issue 处理」任务 disabled 后「归口后没人干」的尾段断链风险升高（#1012 挂 23 天
 *   正是此模式）；纯本地时间戳判断，不引 GitHub API 轮询，机制零膨胀
 * - in_progress 不扫：修复节奏由 PR/worktree 生命周期自己管
 *
 * 告警聚合限流（S4 修订）：同 signal_type 一轮最多落 1 条聚合 healing（context 带 signalIds
 * 数组），不逐条落——存量场景一次 40 条同根因告警 = 呻吟轰炸，消耗处置注意力。
 * 獭间 SignalAgingWorker 不做聚合是因为其信号量小；RHI 量级差异显式处理。
 *
 * 孤儿 healing 清理（S3 修订）：信号终态化（resolved/dismissed）后，其对应 aging healing
 * 同步自动销号（context.signalId 单条格式 + context.signalIds 聚合格式都匹配——
 * mimo delta 附言：两种字段名都要兼容），避免指向已不存在问题的告警挂在自愈台账成噪音债。
 *
 * 为什么 medium 不是 high：处置延迟是流程问题不是系统故障（与 SignalAgingWorker 同口径）。
 */

import type { SignalRepository } from '@usecases/health/signal-repository';
import type { SignalRecord } from '@usecases/health/signal-repository';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';
import type { HealingEvent } from '@entities/healing/healing-event';
import type { Logger } from '@usecases/ports/logger';
import { randomUUID } from 'node:crypto';

/** critical 未接单超 72h 落告警（ms） */
export const RHI_CRITICAL_AGING_THRESHOLD_MS = 72 * 60 * 60 * 1000;
/** warning 未接单超 7d 落告警（ms） */
export const RHI_WARNING_AGING_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
/** triaged 归口停滞超 7 天落告警（ms）——一期纳入（S3 处置收紧） */
export const RHI_TRIAGED_STALL_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** 扫描间隔（默认 1h；unref 不阻退出） */
const RHI_AGING_INTERVAL_MS = 60 * 60 * 1000;

export interface RhiSignalAgingResult {
  scannedAt: string;
  /** 本轮发现的超龄信号总数（未接单 + 归口停滞） */
  agedCount: number;
  /** 本轮新落的聚合告警数（同 signal_type 限 1 条，去重后） */
  alertsCreated: number;
  /** 本轮自动销号的孤儿 healing 数（信号已终态化） */
  orphanHealingsResolved: number;
}

/** 提取 healing context 中携带的 RHI 信号 ID 集合（单条 signalId + 聚合 signalIds 兼容） */
function signalIdsFromContext(context: Record<string, unknown> | null): Set<number> {
  const ids = new Set<number>();
  if (!context) return ids;
  const single = context.signalId;
  if (typeof single === 'number') ids.add(single);
  if (typeof single === 'string' && /^\d+$/.test(single)) ids.add(Number(single));
  const list = context.signalIds;
  if (Array.isArray(list)) {
    for (const v of list) {
      if (typeof v === 'number') ids.add(v);
      else if (typeof v === 'string' && /^\d+$/.test(v)) ids.add(Number(v));
    }
  }
  return ids;
}

export class RhiSignalAgingWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly signalRepo: () => SignalRepository | undefined,
    private readonly healingRepo: () => HealingEventRepository | undefined,
    private readonly logger: Logger,
    private readonly intervalMs: number = RHI_AGING_INTERVAL_MS,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // 启动即扫一轮（学 SignalAgingWorker：服务重启后尽快发现悬置存量）。
    // 编排现实（检视 S2 修正）：PatrolWorker 启动即扫，存量出清依赖服务在线（http/工具路径），
    // 出清必然发生在首轮扫描之后——部署后首轮会落 1 条聚合告警（聚合限流兜底，非风暴），
    // 这是诚实特性：系统确实疼了 23 天，该告警不冤。出清后告警悬置属预期（组内全部终态化才销号），
    // 待 #1012 闭环 auto-resolve 清场或人工 resolve healing。
    this.inflight = this.tickSafely();
    this.timer = setInterval(() => {
      this.inflight = this.tickSafely();
    }, this.intervalMs);
    this.timer?.unref?.();
    this.logger.info('RHI signal aging worker started', { action: 'rhi_signal_aging_worker_start', intervalMs: this.intervalMs });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
    this.logger.info('RHI signal aging worker stopped', { action: 'rhi_signal_aging_worker_stop' });
  }

  private async tickSafely(): Promise<void> {
    try {
      const result = await this.scanOnce();
      if (result.alertsCreated > 0 || result.orphanHealingsResolved > 0) {
        this.logger.warn('Aged RHI signals found', { action: 'rhi_signal_aging_alert', ...result });
      }
    } catch (err) {
      this.logger.error('RHI signal aging scan failed', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 单轮扫描（可独立调用：测试/CLI 手动触发） */
  async scanOnce(now = new Date()): Promise<RhiSignalAgingResult> {
    const scannedAt = now.toISOString();
    const signalRepo = this.signalRepo();
    const healingRepo = this.healingRepo();
    const result: RhiSignalAgingResult = { scannedAt, agedCount: 0, alertsCreated: 0, orphanHealingsResolved: 0 };
    if (!signalRepo || !healingRepo) return result;

    // ── 孤儿 healing 清理（S3）：信号已终态化 → 对应 aging healing 自动销号 ──
    result.orphanHealingsResolved = await this.resolveOrphanHealings(signalRepo, healingRepo, scannedAt);

    // ── 老化扫描：未接单（按 first_seen 计时）+ 归口停滞（按 triaged_at 计时） ──
    const aged = this.filterAged(signalRepo.findOpen(), now);
    result.agedCount = aged.length;
    if (aged.length === 0) return result;

    result.alertsCreated = await this.createAggregateAlerts(aged, healingRepo, scannedAt, now);
    return result;
  }

  /** 聚合限流落账（S4）：同 signal_type 一轮最多 1 条聚合 healing；同 type 已有未销号告警则整组跳过 */
  private async createAggregateAlerts(
    aged: SignalRecord[], healingRepo: HealingEventRepository, scannedAt: string, now: Date,
  ): Promise<number> {
    const byType = new Map<string, SignalRecord[]>();
    for (const sig of aged) {
      const list = byType.get(sig.signal_type) ?? [];
      list.push(sig);
      byType.set(sig.signal_type, list);
    }

    // 去重集：open aging healing 里已覆盖的 signal_type
    const openHealings = await healingRepo.findOpen(500);
    const alertedTypes = new Set<string>();
    for (const h of openHealings) {
      const ctx = h.context as { source?: string; signalType?: string } | null;
      if (ctx?.source === 'rhi-signal-aging-worker' && typeof ctx.signalType === 'string') {
        alertedTypes.add(ctx.signalType);
      }
    }

    let created = 0;
    for (const [signalType, group] of byType) {
      if (alertedTypes.has(signalType)) continue;
      await healingRepo.create(this.buildAggregateEvent(signalType, group, scannedAt, now));
      created++;
    }
    return created;
  }

  /** 构造一条聚合 healing event（同 signal_type 组的告警载体） */
  private buildAggregateEvent(signalType: string, group: SignalRecord[], scannedAt: string, now: Date): HealingEvent {
    const oldest = group.reduce((a, b) => (Date.parse(a.first_seen) < Date.parse(b.first_seen) ? a : b));
    const maxAgeDays = Math.floor((now.getTime() - Date.parse(oldest.first_seen)) / 86400000);
    const criticalCount = group.filter(s => s.severity === 'critical').length;
    return {
      id: randomUUID(),
      messageId: '',
      conversationId: '',
      otterId: 'rhi-signal-aging-worker',
      errorType: 'other',
      severity: 'medium',
      description: `RHI 信号超龄未处置：${signalType} 共 ${group.length} 条（critical ${criticalCount} 条），最老挂 ${maxAgeDays} 天——${this.describeGroup(group)}`,
      suggestion: '处置：09:00 每日健康检查任务「未接单存量清点」步逐条归口（triage_signal bind_issue），或在面板处置队列一键归口；归口停滞的核查绑定 issue 进展',
      context: {
        source: 'rhi-signal-aging-worker',
        signalType,
        signalIds: group.map(s => s.id),
        count: group.length,
        oldestFirstSeen: oldest.first_seen,
      },
      status: 'open',
      resolution: null,
      resolvedAt: null,
      createdAt: scannedAt,
    };
  }

  /** 老化判定：未接单按 first_seen 计时（critical 72h / warning 7d）；triaged 停滞按 triaged_at 计时（7d） */
  private filterAged(openSignals: SignalRecord[], now: Date): SignalRecord[] {
    return openSignals.filter(sig => {
      if (sig.triage_status === null) {
        const age = now.getTime() - Date.parse(sig.first_seen);
        return sig.severity === 'critical'
          ? age > RHI_CRITICAL_AGING_THRESHOLD_MS
          : age > RHI_WARNING_AGING_THRESHOLD_MS;
      }
      if (sig.triage_status === 'triaged' && sig.triaged_at) {
        return now.getTime() - Date.parse(sig.triaged_at) > RHI_TRIAGED_STALL_THRESHOLD_MS;
      }
      // in_progress 不扫：修复节奏由 PR/worktree 生命周期自己管
      return false;
    });
  }

  /** 孤儿 healing 清理（S3）：终态化信号对应的 aging healing 自动销号 */
  private async resolveOrphanHealings(
    signalRepo: SignalRepository,
    healingRepo: HealingEventRepository,
    scannedAt: string,
  ): Promise<number> {
    const openHealings = await healingRepo.findOpen(500);
    let resolved = 0;
    for (const h of openHealings) {
      const src = (h.context as { source?: string } | null)?.source;
      if (src !== 'rhi-signal-aging-worker') continue;
      const ids = signalIdsFromContext(h.context);
      if (ids.size === 0) continue;
      // 组内任一信号仍 open → 告警仍有效，不销号；全部终态化才销。
      let anyOpen = false;
      for (const id of ids) {
        const rec = signalRepo.findById(id);
        if (rec && rec.status === 'open') { anyOpen = true; break; }
      }
      if (anyOpen) continue;
      await healingRepo.resolve(h.id, {
        action: 'no_action',
        decidedBy: 'agent',
        decidedAt: scannedAt,
        notes: '信号已终态，告警自动销号（F20260917trig §3 孤儿 healing 清理）',
      });
      resolved++;
    }
    return resolved;
  }

  /** 聚合告警描述文案：区分未接单与归口停滞两子组 */
  private describeGroup(group: SignalRecord[]): string {
    const untriaged = group.filter(s => s.triage_status === null);
    const stalled = group.filter(s => s.triage_status === 'triaged');
    const parts: string[] = [];
    if (untriaged.length > 0) {
      parts.push(`${untriaged.length} 条未接单`);
    }
    if (stalled.length > 0) {
      parts.push(`${stalled.length} 条已归口但停滞超 7 天`);
    }
    return parts.join('，');
  }
}
