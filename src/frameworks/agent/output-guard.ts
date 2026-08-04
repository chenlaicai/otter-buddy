/**
 * OutputGuard：文本生成退化检测与流式超时（F20260804dglp 重构）。
 *
 * 三重职责：
 * 1. 退化重复检测：text/thinking delta 喂给 DegenerateDetector（双机制），
 *    toolcall_delta 只作活跃信号（合法大文件写入会误伤重复检测）；
 * 2. 超时体系：首字节超时（prompt 前 arm，覆盖排队+prefill）+ per-delta 滑动超时；
 * 3. 健康窗口避让：工具执行 / compaction / auto-retry 期间 pause（冻结语义 + ref-count）。
 *
 * 计时语义（F20260804dglp 根因 2b 修复）：pause 时冻结剩余时间，
 * resume 时按剩余时间重建——pause 时长不计入 elapsed（旧实现 resumeTimer
 * 用 now - timerStartedAt，pause 超时的调用恢复后 1s 必误杀）。
 *
 * 设计文档：F20260727guard-degenerate-output-guard（初版）、F20260804dglp（重构）
 */

import type { Logger } from "@usecases/ports/logger";
import { DegenerateDetector } from "./degenerate-detector";
import type { DegenerateConfig } from "./degenerate-detector";

export interface OutputGuardConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 流式超时（毫秒），连续无新内容则 abort */
  streamingTimeoutMs: number;
  /** 首字节超时（毫秒），prompt 发出后无任何 delta 则 abort；覆盖排队+prefill */
  firstByteTimeoutMs: number;
  /** 退化检测器配置 */
  detector: Partial<DegenerateConfig>;
}

export const DEFAULT_OUTPUT_GUARD_CONFIG: OutputGuardConfig = {
  enabled: true,
  streamingTimeoutMs: 120_000,
  firstByteTimeoutMs: 300_000,
  detector: {},
};

export type OutputGuardTripReason = "degenerate_output" | "streaming_timeout" | "first_byte_timeout";

export interface OutputGuardMetadata {
  totalLength: number;
  tripped: boolean;
  reason?: OutputGuardTripReason;
  /** 首字节延迟埋点（F20260804dglp）：最近一次首字节窗口从 arm 到首个 delta 的耗时，用于调参观测 */
  firstByteLatencyMs?: number;
}

/** pause 原因（ref-count 集合的元素） */
export type PauseReason = "tool" | "compaction" | "auto_retry";

/** delta 类型白名单：text/thinking 进重复检测；toolcall 只作活跃信号 */
const DETECTION_DELTA_TYPES = new Set(["text_delta", "thinking_delta"]);

export class OutputGuard {
  private readonly detector: DegenerateDetector;
  private tripped = false;
  private tripReason: OutputGuardTripReason | undefined;

  /** 当前计时器；budgetMs 为本次 arm 的预算，startedAt 为 arm 时刻 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerBudgetMs = 0;
  private timerStartedAt = 0;
  private timerKind: "first_byte" | "streaming" | null = null;
  /** 最近一次 arm 时传入的 abort（timeout fire 时用） */
  private pendingAbort: (() => void) | null = null;

  /**
   * pause ref-count：按原因计数（并行工具调用会同原因多次 start/end，
   * Set 去重会导致第一个 end 就重建计时器误杀其余工具——PR #138 检视 S1）。
   * 计数归零才真正 resume（冻结语义：pause 时长不计入 elapsed）。
   */
  private readonly pauseCounts = new Map<PauseReason, number>();
  private pauseTotal = 0;
  private pausedRemainingMs: number | null = null;
  private pausedKind: "first_byte" | "streaming" | null = null;

  /** fire 前的兜底查询（SDK compaction 事件丢失时防误杀） */
  private isCompactingFn: (() => boolean) | undefined;
  /** 首字节延迟埋点 */
  private firstByteArmedAt = 0;
  private firstByteLatencyMs: number | undefined;
  /** 终态标记：destroy 后拒绝任何 resume/arm 复活计时器 */
  private destroyed = false;

  constructor(
    private readonly config: OutputGuardConfig,
    private readonly otterId: string,
    private readonly logger: Logger,
  ) {
    this.detector = new DegenerateDetector(config.detector);
  }

  /** 注入 isCompacting 查询（attach 时绑定 session.isCompacting） */
  setIsCompacting(fn: () => boolean): void {
    this.isCompactingFn = fn;
  }

  /** prompt 发出前 arm 首字节计时器（覆盖排队 + prefill 静默期） */
  armFirstByteTimer(abort: () => void): void {
    if (!this.config.enabled || this.tripped || this.destroyed) return;
    this.armTimer("first_byte", this.config.firstByteTimeoutMs, abort);
  }

  /**
   * delta 到达：活跃信号（重置/切换计时器）+ 重复检测（仅 text/thinking）。
   * 检测命中或已 tripped 时返回 true。
   */
  onDelta(delta: string, deltaType: string | undefined, abort: () => void): boolean {
    if (this.tripped) return true;
    if (!this.config.enabled || this.destroyed) return false;

    if (this.pauseTotal === 0) {
      /** 首字节延迟埋点：首字节窗口 → 滑动窗口切换点即首个 delta 到达时刻 */
      if (this.timerKind === "first_byte" && this.firstByteArmedAt > 0) {
        this.firstByteLatencyMs = Date.now() - this.firstByteArmedAt;
      }
      this.armTimer("streaming", this.config.streamingTimeoutMs, abort);
    } else {
      /** pause 期间到达的 delta：生成实际在恢复，把冻结剩余重置为全额滑动预算
       *  （防 SDK 行为变化后 resume 用陈旧小额剩余重建、恢复即误杀） */
      this.pendingAbort = abort;
      this.pausedRemainingMs = this.config.streamingTimeoutMs;
      this.pausedKind = "streaming";
    }

    if (!DETECTION_DELTA_TYPES.has(deltaType ?? "")) return false;

    const verdict = this.detector.add(delta);
    if (verdict.degenerate) {
      this.tripped = true;
      this.tripReason = "degenerate_output";
      /** trip 即停表：否则僵尸计时器会在 abort 展开期间二次 fire，
       *  覆写 tripReason（degenerate_output → streaming_timeout）并重复 abort（检视 S2） */
      this.clearTimerOnly();
      this.logger.warn(
        `[output-guard] Degenerate output detected: otter=${this.otterId} ` +
        `mechanism=${verdict.mechanism} ${verdict.detail}`,
      );
      abort();
      return true;
    }
    return false;
  }

  /** 块边界（text_start/thinking_start）：重置检测器累积 */
  onBlockBoundary(): void {
    this.detector.reset();
  }

  /** pause（冻结语义）：首个暂停原因记录剩余时间并停表；同原因可叠加（并行工具） */
  pause(reason: PauseReason): void {
    if (this.destroyed) return;
    if (this.pauseTotal === 0 && this.timer !== null) {
      this.pausedRemainingMs = Math.max(this.timerBudgetMs - (Date.now() - this.timerStartedAt), 0);
      this.pausedKind = this.timerKind;
      this.clearTimerOnly();
    }
    this.pauseCounts.set(reason, (this.pauseCounts.get(reason) ?? 0) + 1);
    this.pauseTotal++;
  }

  /**
   * resume：计数归零后重建计时器。
   * 最后释放的原因是 compaction / auto_retry 时 re-arm 首字节窗口（后续是冷请求全量 prefill）；
   * 工具结束恢复冻结的剩余时间。
   */
  resume(reason: PauseReason, abort: () => void): void {
    const count = this.pauseCounts.get(reason) ?? 0;
    if (count === 0) return;
    if (count === 1) this.pauseCounts.delete(reason);
    else this.pauseCounts.set(reason, count - 1);
    this.pauseTotal--;
    this.pendingAbort = abort;
    if (this.pauseTotal > 0) return;
    if (this.tripped || !this.config.enabled || this.destroyed) return;

    if (reason === "compaction" || reason === "auto_retry") {
      this.armTimer("first_byte", this.config.firstByteTimeoutMs, abort);
      return;
    }
    if (this.pausedRemainingMs !== null) {
      this.armTimer(this.pausedKind ?? "streaming", Math.max(this.pausedRemainingMs, 1), abort);
      this.pausedRemainingMs = null;
      this.pausedKind = null;
    }
  }

  get isPaused(): boolean {
    return this.pauseTotal > 0;
  }

  /** 清理资源，必须在 invoke 生命周期的 finally 块中调用；终态，不可复活 */
  destroy(): void {
    this.destroyed = true;
    this.clearTimerOnly();
    this.pauseCounts.clear();
    this.pauseTotal = 0;
    this.pendingAbort = null;
  }

  getMetadata(): OutputGuardMetadata {
    return {
      totalLength: this.detector.length,
      tripped: this.tripped,
      reason: this.tripReason,
      firstByteLatencyMs: this.firstByteLatencyMs,
    };
  }

  private armTimer(kind: "first_byte" | "streaming", budgetMs: number, abort: () => void): void {
    this.clearTimerOnly();
    this.timerKind = kind;
    this.timerBudgetMs = budgetMs;
    this.timerStartedAt = Date.now();
    /** 首字节窗口 arm 时刻同步刷新埋点基准（compaction/auto_retry re-arm 也走这里，
     *  否则埋点会把"原始 arm→delta"记成 TTFT 并覆盖真值——检视 S3） */
    if (kind === "first_byte") this.firstByteArmedAt = this.timerStartedAt;
    this.pendingAbort = abort;
    this.timer = setTimeout(() => this.onTimeout(), budgetMs);
  }

  private onTimeout(): void {
    this.timer = null;
    /** trip 后可能残留到期回调（防御；正常路径 trip 已停表） */
    if (this.tripped || this.destroyed) return;
    /** SDK 事件丢失兜底：compaction 进行中是健康零 delta，不 fire，重新 arm */
    if (this.isCompactingFn?.()) {
      this.logger.warn(`[output-guard] Timeout suppressed by isCompacting fallback: otter=${this.otterId} kind=${this.timerKind}`);
      if (this.pendingAbort) this.armTimer(this.timerKind ?? "streaming", this.timerBudgetMs, this.pendingAbort);
      return;
    }
    this.tripped = true;
    this.tripReason = this.timerKind === "first_byte" ? "first_byte_timeout" : "streaming_timeout";
    this.logger.warn(
      `[output-guard] ${this.tripReason}: otter=${this.otterId} ` +
      `timeoutMs=${this.timerBudgetMs} totalLength=${this.detector.length}`,
    );
    this.pendingAbort?.();
  }

  private clearTimerOnly(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * 将 OutputGuard 挂载到 session 的事件订阅上。
 * 返回 guard 实例（用于 getMetadata / armFirstByteTimer）和 cleanup 函数（finally 块调用）。
 * config 缺省字段自动以 DEFAULT_OUTPUT_GUARD_CONFIG 补全。
 *
 * 事件契约（SDK agent-core 原始事件，subscribe 通道）：
 * - message_update: { assistantMessageEvent: { type, delta? } } —— delta 在内层
 *   （F20260804dglp 根因 2：初版读外层 event.delta，恒 undefined，guard 从未生效）
 * - tool_execution_start/end、compaction_start/end、auto_retry_start/end：pause/resume
 */
export function attachOutputGuard(
  session: {
    subscribe: (fn: (event: unknown) => void) => () => void;
    isCompacting?: boolean;
  },
  otterId: string,
  config: Partial<OutputGuardConfig>,
  logger: Logger,
  onAbort: () => void,
): { guard: OutputGuard; cleanup: () => void } {
  const fullConfig: OutputGuardConfig = {
    ...DEFAULT_OUTPUT_GUARD_CONFIG,
    ...config,
    detector: { ...DEFAULT_OUTPUT_GUARD_CONFIG.detector, ...config.detector },
  };
  const guard = new OutputGuard(fullConfig, otterId, logger);
  if (!fullConfig.enabled) {
    return { guard, cleanup: () => {} };
  }

  /** isCompacting 兜底（SDK 事件改名/丢失时防 fire 误杀）；SDK 是 getter，每次调用时现读 */
  const sessionRecord = session as Record<string, unknown>;
  if (typeof sessionRecord.isCompacting === "boolean") {
    guard.setIsCompacting(() => Boolean(sessionRecord.isCompacting));
  }

  const unsubscribe = session.subscribe((event: unknown) => {
    const e = event as {
      type?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
    };
    switch (e.type) {
      case "message_update": {
        const ame = e.assistantMessageEvent;
        if (!ame) break;
        if (ame.type === "text_start" || ame.type === "thinking_start") guard.onBlockBoundary();
        if (ame.delta) guard.onDelta(ame.delta, ame.type, onAbort);
        break;
      }
      case "tool_execution_start":
        guard.pause("tool");
        break;
      case "tool_execution_end":
        guard.resume("tool", onAbort);
        break;
      case "compaction_start":
        guard.pause("compaction");
        break;
      case "compaction_end":
        guard.resume("compaction", onAbort);
        break;
      case "auto_retry_start":
        guard.pause("auto_retry");
        break;
      case "auto_retry_end":
        guard.resume("auto_retry", onAbort);
        break;
    }
  });

  return { guard, cleanup: () => { guard.destroy(); unsubscribe(); } };
}
