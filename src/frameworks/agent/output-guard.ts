/**
 * OutputGuard：文本生成退化检测与流式超时。
 *
 * 防止 LLM 陷入退化重复输出循环（degenerate repetition loop），
 * 同时提供流式超时兜底，防止生成过程静默卡死。
 *
 * 通过 session.subscribe() 订阅 message_update 事件实现监控。
 *
 * 设计文档：F20260727guard-degenerate-output-guard
 */

import type { Logger } from "@usecases/ports/logger";

export interface OutputGuardConfig {
  /** 是否启用退化检测 */
  enabled: boolean;
  /** 片段长度（字符），用于重复模式检测 */
  segmentLength: number;
  /** 相同片段重复多少次触发 abort */
  maxRepeatedSegments: number;
  /** 每累积多少个片段检查一次重复 */
  checkInterval: number;
  /** 流式超时（毫秒），连续无新内容则 abort */
  streamingTimeoutMs: number;
}

export const DEFAULT_OUTPUT_GUARD_CONFIG: OutputGuardConfig = {
  enabled: true,
  segmentLength: 100,
  maxRepeatedSegments: 50,
  checkInterval: 20,
  streamingTimeoutMs: 120_000,
};

export interface OutputGuardMetadata {
  totalLength: number;
  tripped: boolean;
  reason?: "degenerate_output" | "streaming_timeout";
}

export class OutputGuard {
  private accumulated = "";
  private readonly recentSegments: string[] = [];
  private segmentCheckCount = 0;
  private tripped = false;
  private tripReason: "degenerate_output" | "streaming_timeout" | undefined;
  private streamingTimer: ReturnType<typeof setTimeout> | null = null;
  private timerPaused = false;

  constructor(
    private readonly config: OutputGuardConfig,
    private readonly otterId: string,
    private readonly logger: Logger,
  ) {}

  /**
   * 处理 message_update 的文本增量。
   * 检测到退化输出时调用 abort 并返回 true。
   */
  check(delta: string, abort: () => void): boolean {
    if (this.tripped) return true;
    if (!this.config.enabled) return false;

    // 1. 累积文本
    this.accumulated += delta;

    // 2. 重置流式超时计时器
    this.resetStreamingTimer(abort);

    // 3. 检查是否攒满一个新片段
    const targetLength = (this.segmentCheckCount + 1) * this.config.segmentLength;
    if (this.accumulated.length < targetLength) return false;

    // 4. 提取并存储新片段
    const segment = this.accumulated.slice(
      this.segmentCheckCount * this.config.segmentLength,
      targetLength,
    );
    this.recentSegments.push(segment);
    this.segmentCheckCount++;

    // 5. 每 checkInterval 个片段检查一次重复
    if (this.segmentCheckCount % this.config.checkInterval !== 0) return false;

    // 6. 统计最新片段在历史中出现的次数
    const count = this.segmentOccurrences(segment);
    if (count >= this.config.maxRepeatedSegments) {
      this.tripped = true;
      this.tripReason = "degenerate_output";
      this.logger.warn(
        `[output-guard] Degenerate output detected: otter=${this.otterId} ` +
        `segmentLength=${this.config.segmentLength} repeats=${count} ` +
        `threshold=${this.config.maxRepeatedSegments} totalLength=${this.accumulated.length}`,
      );
      abort();
      return true;
    }

    return false;
  }

  /** 工具执行开始时暂停超时计时器（防止工具执行期间误触发） */
  pauseTimer(): void {
    if (this.streamingTimer !== null) {
      clearTimeout(this.streamingTimer);
      this.streamingTimer = null;
      this.timerPaused = true;
    }
  }

  /** 清理资源，必须在 invoke 生命周期的 finally 块中调用 */
  destroy(): void {
    if (this.streamingTimer !== null) {
      clearTimeout(this.streamingTimer);
      this.streamingTimer = null;
    }
  }

  getMetadata(): OutputGuardMetadata {
    return {
      totalLength: this.accumulated.length,
      tripped: this.tripped,
      reason: this.tripReason,
    };
  }

  private resetStreamingTimer(abort: () => void): void {
    if (this.streamingTimer !== null) {
      clearTimeout(this.streamingTimer);
    }
    this.timerPaused = false;
    this.streamingTimer = setTimeout(() => {
      this.tripped = true;
      this.tripReason = "streaming_timeout";
      this.logger.warn(
        `[output-guard] Streaming timeout: otter=${this.otterId} ` +
        `timeoutMs=${this.config.streamingTimeoutMs} totalLength=${this.accumulated.length}`,
      );
      abort();
    }, this.config.streamingTimeoutMs);
  }

  /**
   * 统计 segment 在 recentSegments 中出现的总次数（含自身）。
   * maxRepeatedSegments=5 表示"该片段总共出现 5 次则触发"。
   */
  private segmentOccurrences(segment: string): number {
    let count = 0;
    for (const seg of this.recentSegments) {
      if (seg === segment) count++;
    }
    return count;
  }
}

/**
 * 将 OutputGuard 挂载到 session 的事件订阅上。
 * 返回 guard 实例（用于 getMetadata）和 cleanup 函数（用于 finally 块）。
 * config 缺省字段自动以 DEFAULT_OUTPUT_GUARD_CONFIG 补全。
 *
 * @param onAbort - 触发 abort 时的回调。由工厂注入，确保走正确的 abort 流程
 *                  （而非直接调用 session.abort() 绕过 AgentInvoker 的 abortedMessages 标记）。
 */
export function attachOutputGuard(
  session: {
    subscribe: (fn: (event: unknown) => void) => () => void;
  },
  otterId: string,
  config: Partial<OutputGuardConfig>,
  logger: Logger,
  onAbort: () => void,
): { guard: OutputGuard; cleanup: () => void } {
  const fullConfig = { ...DEFAULT_OUTPUT_GUARD_CONFIG, ...config };
  const guard = new OutputGuard(fullConfig, otterId, logger);
  if (!config.enabled) {
    return { guard, cleanup: () => {} };
  }

  const unsubscribe = session.subscribe((event: unknown) => {
    const e = event as { type?: string; delta?: string };
    switch (e.type) {
      case "message_update":
        if (e.delta) {
          guard.check(e.delta, onAbort);
        }
        break;
      case "tool_execution_start":
        guard.pauseTimer();
        break;
      // tool_execution_end 不处理 — 等下一个 message_update 自然恢复计时器
    }
  });

  return { guard, cleanup: () => { guard.destroy(); unsubscribe(); } };
}
