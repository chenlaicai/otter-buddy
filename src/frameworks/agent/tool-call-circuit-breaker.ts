/**
 * ToolCallCircuitBreaker：Agent 工具调用熔断器。
 *
 * 防止 agent 陷入无限工具调用循环，保护 token 资源。
 * 通过 harness.on('tool_call') 钩子拦截，利用 harness.steer() 注入纠正提示。
 *
 * 设计文档：F20260716bte2-agent-circuit-breaker
 */

import type { Logger } from "@usecases/ports/logger";

export interface CircuitBreakerConfig {
  maxToolCalls: number;
  maxConsecutiveIdentical: number;
  maxExecutionTimeMs: number;
  warningThreshold: number;
  slidingWindowSize: number;
  slidingWindowRepeat: number;
  steerTimeoutMs: number;
  tokenWarningThreshold: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  maxToolCalls: 40,
  maxConsecutiveIdentical: 5,
  maxExecutionTimeMs: 300_000,
  warningThreshold: 20,
  slidingWindowSize: 6,
  slidingWindowRepeat: 3,
  steerTimeoutMs: 30_000,
  tokenWarningThreshold: 50_000,
};

interface CheckResult {
  blocked: boolean;
  reason?: string;
  action: "allow" | "warn" | "steer" | "terminate";
}

/**
 * 滑动窗口检测：最近 K 次工具调用中，相同工具组合（集合相等）重复出现 M 次。
 * B-3b：检测跨工具交替循环（如 A-B-C-A-B-C）。
 */
function detectSlidingWindowRepeat(
  history: string[],
  windowSize: number,
  repeatThreshold: number,
): boolean {
  if (history.length < windowSize * repeatThreshold) return false;

  const recent = history.slice(-windowSize * repeatThreshold);
  const patternCount = new Map<string, number>();

  for (let i = 0; i <= recent.length - windowSize; i++) {
    const window = recent.slice(i, i + windowSize);
    const pattern = [...window].sort().join(",");
    patternCount.set(pattern, (patternCount.get(pattern) ?? 0) + 1);
  }

  for (const count of patternCount.values()) {
    if (count >= repeatThreshold) return true;
  }
  return false;
}

export class ToolCallCircuitBreaker {
  private callCount = 0;
  private readonly callHistory: string[] = [];
  private readonly startTime: number;
  private consecutiveCount = 0;
  private lastToolName: string | null = null;
  private lastCheckResult: CheckResult | null = null;
  private steered = false;
  private steerDeadline: ReturnType<typeof setTimeout> | null = null;
  private steerDeadlineAt: number | null = null;

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly otterId: string,
    private readonly logger: Logger,
    private readonly stageId?: string,
  ) {
    this.startTime = Date.now();
  }

  /**
   * 检查工具调用是否应被拦截。
   * 由 harness.on('tool_call') 钩子调用。
   */
  check(toolName: string): CheckResult {
    this.callCount++;
    this.callHistory.push(toolName);
    this.updateConsecutive(toolName);

    const result = this.evaluate(toolName);
    this.lastCheckResult = result;
    return result;
  }

  /** 更新连续相同工具计数 */
  private updateConsecutive(toolName: string): void {
    if (toolName === this.lastToolName) {
      this.consecutiveCount++;
    } else {
      this.consecutiveCount = 1;
      this.lastToolName = toolName;
    }
  }

  /** 按优先级评估各项熔断规则 */
  private evaluate(toolName: string): CheckResult {
    return this.checkToolCallLimit()
      ?? this.checkConsecutive(toolName)
      ?? this.checkSlidingWindow()
      ?? this.checkExecutionTimeout()
      ?? this.checkSteerDeadline()
      ?? { blocked: false, action: "allow" };
  }

  /** B-1/B-2/B-5: 工具调用次数检查 */
  private checkToolCallLimit(): CheckResult | null {
    if (this.callCount === this.config.warningThreshold) {
      this.logger.warn(`[circuit-breaker] Warning: otter=${this.otterId} tool_calls=${this.callCount}`);
    }
    if (this.callCount <= this.config.maxToolCalls) return null;
    if (this.callCount > this.config.maxToolCalls + 3) {
      this.logCircuitBreak("tool_call_limit");
      return { blocked: true, reason: `Force terminated: ${this.callCount} tool calls exceed hard limit`, action: "terminate" };
    }
    this.steered = true;
    return { blocked: true, reason: `Tool call limit reached (${this.callCount}/${this.config.maxToolCalls}). Call set_final_body immediately.`, action: "steer" };
  }

  /** B-3: 连续相同工具检查 */
  private checkConsecutive(toolName: string): CheckResult | null {
    if (this.consecutiveCount <= this.config.maxConsecutiveIdentical) return null;
    return { blocked: true, reason: `Consecutive identical tool "${toolName}" called ${this.consecutiveCount} times. Break the pattern.`, action: "steer" };
  }

  /** B-3b: 滑动窗口跨工具交替循环检查 */
  private checkSlidingWindow(): CheckResult | null {
    if (!detectSlidingWindowRepeat(this.callHistory, this.config.slidingWindowSize, this.config.slidingWindowRepeat)) return null;
    return { blocked: true, reason: `Repeating tool call pattern detected in sliding window (K=${this.config.slidingWindowSize}, M=${this.config.slidingWindowRepeat}). Break the cycle.`, action: "steer" };
  }

  /** B-4: 执行时间超限检查 */
  private checkExecutionTimeout(): CheckResult | null {
    const elapsed = Date.now() - this.startTime;
    if (elapsed <= this.config.maxExecutionTimeMs) return null;
    this.logCircuitBreak("timeout");
    return { blocked: true, reason: `Execution timeout: ${(elapsed / 1000).toFixed(1)}s exceeds ${this.config.maxExecutionTimeMs / 1000}s limit`, action: "terminate" };
  }

  /** B-5b: steer 后 wall-clock 超时安全网 */
  private checkSteerDeadline(): CheckResult | null {
    if (this.steerDeadlineAt === null) return null;
    if (Date.now() <= this.steerDeadlineAt) return null;
    return { blocked: true, reason: "Steer deadline exceeded", action: "terminate" };
  }

  /**
   * 设置 steer 超时截止时间。
   * B-5b：从 steer 注入起算 30 秒 wall-clock 硬边界。
   */
  setSteerDeadline(forceAbort: () => void): void {
    if (this.steerDeadline) {
      clearTimeout(this.steerDeadline);
    }
    this.steerDeadlineAt = Date.now() + this.config.steerTimeoutMs;
    this.steerDeadline = setTimeout(() => {
      this.logger.warn(
        `[circuit-breaker] Steer timeout: otter=${this.otterId} — force aborting after ${this.config.steerTimeoutMs}ms`,
      );
      this.logCircuitBreak("steer_timeout");
      forceAbort();
    }, this.config.steerTimeoutMs);
  }

  /** 清除 steer 超时计时器 */
  clearSteerDeadline(): void {
    if (this.steerDeadline) {
      clearTimeout(this.steerDeadline);
      this.steerDeadline = null;
    }
    this.steerDeadlineAt = null;
  }

  /** 获取调用历史（用于 B-6 完整日志） */
  getCallHistory(): string[] {
    return [...this.callHistory];
  }

  /** 获取元数据（用于 B-7 消息元数据记录） */
  getMetadata(): { totalCalls: number; circuitReason?: string } {
    return {
      totalCalls: this.callCount,
      circuitReason: this.lastCheckResult?.action !== "allow"
        ? this.lastCheckResult?.reason
        : undefined,
    };
  }

  /** B-6: 记录完整调用历史到日志 */
  private logCircuitBreak(trigger: string): void {
    this.logger.warn(
      `[circuit-breaker] CIRCUIT_BREAK: otter=${this.otterId} trigger=${trigger} calls=${this.callCount} history=[${this.callHistory.join(",")}]`,
    );
  }
}
