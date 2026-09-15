/**
 * 獭间信号老化扫描（#927 流程层）。
 *
 * 现场事故：blocked 信号悬置 6 天无人裁决——signal 对账段挂在 daily review 调度链上，
 * 9/10-9/13 调度器断档（#912/#913）期间唯一消费方停摆，违规漏网。
 *
 * 本 worker 独立于 daily review：app 级 1h setInterval（unref，不阻退出），
 * 扫 signal_events 中 pending 态 objection/blocked（halt 不扫——halt 无待裁决事项，
 * 首次注入即 resolved），created_at 距今 >24h 落一条 medium healing event
 * （errorType=other，severity=medium，context 带 signalId 供跟进）。
 *
 * 为什么 medium 不是 high：悬置 24h 是流程违规（裁决义务被遗忘），不是系统故障；
 * high 走 healing-alert 即时唤醒链路（C3），留给运行时异常。
 *
 * 落账去重：同一 signalId 只落一次老化告警——scan 前查 open healing 事件的
 * context.signalId 是否已存在。healing 事件被 resolve 后若信号仍 pending，
 * 下一轮会再落一条（间隔 ≥24h，可接受——持续悬置本就该持续可见）。
 */

import type { SignalEventRepository } from '@usecases/signal/signal-event-repository';
import type { HealingEventRepository } from '@usecases/healing/healing-event-repository';
import type { HealingEvent } from '@entities/healing/healing-event';
import type { Logger } from '@usecases/ports/logger';
import { randomUUID } from 'node:crypto';

/** pending 态信号的裁决时限（ms）——超时落老化告警 */
export const SIGNAL_AGING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** 扫描间隔（默认 1h；unref 不阻退出） */
const SIGNAL_AGING_INTERVAL_MS = 60 * 60 * 1000;

export interface SignalAgingResult {
  scannedAt: string;
  /** 本轮发现的超时 pending 信号数 */
  agedCount: number;
  /** 本轮新落的老化告警数（去重后） */
  alertsCreated: number;
}

export class SignalAgingWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly signalRepo: () => SignalEventRepository | undefined,
    private readonly healingRepo: () => HealingEventRepository | undefined,
    private readonly logger: Logger,
    private readonly intervalMs: number = SIGNAL_AGING_INTERVAL_MS,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // 启动即扫一轮（不等 interval——服务重启后 5 分钟内发现悬置存量）
    this.inflight = this.tickSafely();
    this.timer = setInterval(() => {
      this.inflight = this.tickSafely();
    }, this.intervalMs);
    this.timer?.unref?.();
    this.logger.info('Signal aging worker started', { action: 'signal_aging_worker_start', intervalMs: this.intervalMs });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
    this.logger.info('Signal aging worker stopped', { action: 'signal_aging_worker_stop' });
  }

  private async tickSafely(): Promise<void> {
    try {
      const result = await this.scanOnce();
      if (result.alertsCreated > 0) {
        this.logger.warn('Aged pending signals found', { action: 'signal_aging_alert', ...result });
      }
    } catch (err) {
      this.logger.error('Signal aging scan failed', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** 单轮扫描（可独立调用：测试/CLI 手动触发） */
  async scanOnce(now = new Date()): Promise<SignalAgingResult> {
    const scannedAt = now.toISOString();
    const signalRepo = this.signalRepo();
    const healingRepo = this.healingRepo();
    const result: SignalAgingResult = { scannedAt, agedCount: 0, alertsCreated: 0 };
    if (!signalRepo || !healingRepo) return result;

    // signal_events 是按对话存储的库——findAll 跨对话全量（F20260912avlb）
    const pendings = await signalRepo.findAll({ status: 'pending' }, 200);
    const aged = pendings.filter(e =>
      e.type === 'objection' || e.type === 'blocked')
      .filter(e => now.getTime() - Date.parse(e.createdAt) > SIGNAL_AGING_THRESHOLD_MS);
    result.agedCount = aged.length;

    if (aged.length === 0) return result;

    // 去重：open healing 里已有该 signalId 的老化告警则跳过
    const openHealings = await healingRepo.findOpen(500);
    const alertedIds = new Set(openHealings
      .map(h => (h.context as { signalId?: string } | null)?.signalId)
      .filter((v): v is string => typeof v === 'string'));

    for (const sig of aged) {
      if (alertedIds.has(sig.id)) continue;
      const event: HealingEvent = {
        id: randomUUID(),
        messageId: sig.messageId,
        conversationId: sig.conversationId,
        otterId: sig.fromOtterId,
        errorType: 'other',
        severity: 'medium',
        description: `獭间信号悬置超 ${Math.floor(SIGNAL_AGING_THRESHOLD_MS / 3600000)}h 未裁决：${sig.type}（发起者 ${sig.fromOtterId}，payload 摘要：${sig.payload.slice(0, 100)}）——违反「objection 下一轮派工前裁决 / blocked 当场裁决」义务`,
        suggestion: `调 query_signals 查 ${sig.id.slice(0, 8)} 详情并 resolve_signal 裁决；若来源会话已无续办价值，dismissed 留痕即可`,
        context: { signalId: sig.id, signalType: sig.type, fromOtterId: sig.fromOtterId, createdAt: sig.createdAt, source: 'signal-aging-worker' },
        status: 'open',
        resolution: null,
        resolvedAt: null,
        createdAt: scannedAt,
      };
      await healingRepo.create(event);
      result.alertsCreated++;
    }
    return result;
  }
}
