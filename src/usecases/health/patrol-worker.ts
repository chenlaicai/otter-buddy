/**
 * 巡检 worker（#949）：四个「扫台账」同构循环合并为单一定时器。
 *
 * 背景（chen 15:09「后台循环太多」裁决 → 闹钟盘点 timer-audit-20260915）：
 * 运行时对账 / Signal Aging / RHI Scan / Embedding Retry 是同一动作模式——
 * 「定时醒来 → 扫台账 → 异常落账/重建」，此前各挂一个 setInterval（8 个常驻循环）。
 * 本 worker 合并为 1 个 1h 定时器，醒来依次执行四家职责，常驻循环 8→5。
 *
 * 职责注册模式（Registry）：各家实现 PatrolDuty 接口（name + run()），
 * 失败隔离——一家炸了 catch 落 error 日志，不影响后续家（与合并前各自
 * tickSafely 的语义对齐）。run 顺序即注册顺序（对账先行——它是调度健康
 * 的第一可见性）。
 *
 * 周期：1h（四家原周期已对齐——#948 把 Embedding Retry 降到 1h 后全体同节奏，
 * 合并无时钟语义变化）。启动即跑一轮（对齐 signal-aging-worker 的存量发现语义）。
 */

import type { Logger } from '@usecases/ports/logger';

/** 巡检间隔（默认 1h；unref 不阻退出） */
const PATROL_INTERVAL_MS = 60 * 60 * 1000;

/** 一项巡检职责：定时醒来要干的一家事 */
export interface PatrolDuty {
  /** 职责名（日志/指标标识用，如 'scheduler-reconcile'） */
  readonly name: string;
  /** 执行一轮。实现方自行保证幂等（各扫台账族本来就幂等/去重）。 */
  run(): Promise<void>;
}

export class PatrolWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly duties: PatrolDuty[],
    private readonly logger: Logger,
    private readonly intervalMs: number = PATROL_INTERVAL_MS,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // 启动即巡一轮（不等 interval——服务重启后尽快发现存量异常）
    this.inflight = this.tickSafely();
    this.timer = setInterval(() => {
      // 定时器回调自查 stopped（stop 后不再巡）；手动 tickSafely 不受此限（测试/CLI 总是可用）
      if (this.stopped) return;
      this.inflight = this.tickSafely();
    }, this.intervalMs);
    this.timer?.unref?.();
    this.logger.info('Patrol worker started', {
      action: 'patrol_worker_start',
      intervalMs: this.intervalMs,
      duties: this.duties.map(d => d.name),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
    this.logger.info('Patrol worker stopped', { action: 'patrol_worker_stop' });
  }

  /** 手动巡一轮（测试/CLI 用——未 start 也可调；timer 回调的 stopped 守卫在 start() 闭包里） */
  async tickSafely(): Promise<void> {
    for (const duty of this.duties) {
      try {
        await duty.run();
      } catch (err) {
        // 失败隔离：一家炸了不影响后续家（与合并前各自 tickSafely 语义对齐）
        this.logger.error(`Patrol duty failed: ${duty.name}`, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
