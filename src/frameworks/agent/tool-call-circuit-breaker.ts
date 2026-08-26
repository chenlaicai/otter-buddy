/**
 * ToolCallCircuitBreaker：Agent 工具调用熔断器。
 *
 * 防止 agent 陷入无限工具调用循环，保护 token 资源。
 * 通过 tool_execution_start 事件拦截，利用 session.steer() 注入纠正提示。
 *
 * 行为范式（事件驱动两档制，F20260728cbwt）：
 *   首次触发规则 → steer 警告；警告后仍不纠正、继续触发规则满 maxRepeatAfterWarning 次
 *   → terminate 当场中断。中途出现任何一次正常调用（allow）即解除警告状态。
 *   时间维度的挂死保护由 per-event 超时（circuit-breaker-helpers 中 resettable timer）负责，熔断器只管行为模式。
 *
 * 设计文档：F20260716bte2-agent-circuit-breaker（初版）、F20260728cbwt（事件驱动改造）
 */

import type { Logger } from "@usecases/ports/logger";

export interface CircuitBreakerConfig {
  maxConsecutiveIdentical: number;
  /** 首次 steer 警告后，容忍的继续触发次数；超过则 terminate */
  maxRepeatAfterWarning: number;
  /** 单次工具调用最大执行时间（ms），超过则 abort */
  maxPerEventTimeMs: number;
  slidingWindowSize: number;
  slidingWindowRepeat: number;
  tokenWarningThreshold: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  maxConsecutiveIdentical: 5,
  maxRepeatAfterWarning: 5,
  maxPerEventTimeMs: 600_000,
  slidingWindowSize: 6,
  slidingWindowRepeat: 3,
  tokenWarningThreshold: 50_000,
};

interface CheckResult {
  blocked: boolean;
  reason?: string;
  action: "allow" | "warn" | "steer" | "terminate";
  /** terminate 的触发规则标识，用于向上传递 abort 原因 */
  trigger?: string;
}

/**
 * 命令分发器：首个词是这些命令时，子命令才有区分度
 * （`git status` 与 `git commit` 是不同行为，`ls -a` 与 `ls -l` 不是）。
 */
const COMMAND_DISPATCHERS = new Set([
  "git", "gh", "npm", "npx", "yarn", "pnpm", "bun", "deno", "node",
  "docker", "docker-compose", "kubectl", "sudo", "brew", "cargo", "go",
  "pip", "pip3", "python", "python3", "make", "mvn", "gradle", "poetry", "uv",
]);

/** 包装命令：穿透取真实命令（`sudo git status` 按 `git status` 计） */
const COMMAND_WRAPPERS = new Set(["sudo", "time", "env", "nice", "watch"]);

/** 带子命令值的 flag：跳过 flag 时需连值一起跳（`git -C /repo status` → `git status`） */
const VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

const basename = (word: string): string => word.split("/").pop() ?? word;

/** 提取 bash 命令的行为签名：按 shell 操作符切段，取每段的命令词（分发器带子命令），忽略参数 */
function bashCommandSignature(command: string): string {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const words = segment.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      let i = 0;
      while (i < words.length && (COMMAND_WRAPPERS.has(basename(words[i])) || words[i].startsWith("-"))) i++;
      if (i >= words.length) return "";
      const cmd = basename(words[i]);
      if (!COMMAND_DISPATCHERS.has(cmd)) return cmd;
      for (let j = i + 1; j < words.length; j++) {
        const w = words[j];
        if (w.startsWith("-")) {
          if (VALUE_FLAGS.has(w)) j++;
          continue;
        }
        return `${cmd} ${w}`;
      }
      return cmd;
    })
    .filter(Boolean)
    .join(" | ");
}

/** 短内容指纹（djb2，限长防大文件拖慢）：区分「同一文件的不同编辑」与「同一编辑的反复重试」 */
function contentDigest(text: string): string {
  const bound = text.length > 4096 ? text.slice(0, 4096) : text;
  let h = 5381;
  for (let i = 0; i < bound.length; i++) {
    h = ((h << 5) + h + bound.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** 提取 edit/write 的内容指纹；无内容信息时返回空串 */
function editContentDigest(toolName: string, a: Record<string, unknown>): string {
  if (toolName === "write" && typeof a.content === "string") {
    return contentDigest(a.content);
  }
  if (toolName === "edit") {
    if (Array.isArray(a.edits)) {
      const pairs = a.edits
        .map((e) => {
          const p = (e ?? {}) as Record<string, unknown>;
          return `${String(p.oldText ?? p.old_string ?? "")}→${String(p.newText ?? p.new_string ?? "")}`;
        })
        .join("\n");
      if (pairs) return contentDigest(pairs);
    }
    const single = `${String(a.oldText ?? a.old_string ?? "")}→${String(a.newText ?? a.new_string ?? "")}`;
    if (single !== "→") return contentDigest(single);
  }
  return "";
}

/** 文件类工具签名：read 取路径；edit/write 取路径+内容指纹（区分不同编辑与同一编辑重试） */
function fileToolSignature(toolName: string, a: Record<string, unknown>): string {
  const path = a.path ?? a.filePath ?? a.file_path;
  if (typeof path !== "string" || !path) return toolName;
  if (toolName === "read") return `read: ${path}`;
  const digest = editContentDigest(toolName, a);
  return digest ? `${toolName}: ${path}#${digest}` : `${toolName}: ${path}`;
}

/**
 * 构建工具调用的行为签名（"连续相同"的判据）。
 * 同名工具不同行为不算重复：bash 看命令词、read 看目标路径、edit/write 看路径+内容指纹；
 * 真正的卡壳（同一命令反复失败、同一编辑反复重试、反复读同一文件）才会累计。
 *
 * F20260820d338：speak 加入 body 内容指纹——连续 speak 不同内容不算重复，
 * 同一 speak 内容反复输出才累计（与 write/edit 同理）。
 */
export function buildToolSignature(toolName: string, args?: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (toolName === "bash" && typeof a.command === "string") {
    const sig = bashCommandSignature(a.command);
    return sig ? `bash: ${sig}` : "bash";
  }
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return fileToolSignature(toolName, a);
  }
  // F20260820d338：speak 签名含 body 内容指纹，区分不同输出与同一输出重试
  if (toolName === "speak" && typeof a.body === "string") {
    const digest = contentDigest(a.body);
    return `speak#${digest}`;
  }
  // F20260826d464：otter 管理工具签名含实体标识——批量解散/重启不同 otter 不算重复
  if (toolName === "dissolve_otter" || toolName === "restart_otter") {
    const id = a.otterId;
    return typeof id === "string" && id ? `${toolName}: ${id}` : toolName;
  }
  if (toolName === "create_otter") {
    const name = a.name;
    return typeof name === "string" && name ? `${toolName}: ${name}` : toolName;
  }
  return toolName;
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
  private static readonly MAX_HISTORY = 100;
  private callCount = 0;
  private readonly callHistory: string[] = [];
  private consecutiveCount = 0;
  private lastSignature: string | null = null;
  private lastCheckResult: CheckResult | null = null;
  /** 自上次 allow 以来连续 steer 的次数；allow 即清零（行为纠正即解除警告） */
  private steerStrikes = 0;

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly otterId: string,
    private readonly logger: Logger,
    private readonly stageId?: string,
  ) {}


  /**
   * 检查工具调用是否应被拦截。
   * 由 tool_execution_start 事件驱动，args 为事件携带的工具参数（用于行为签名）。
   */
  check(toolName: string, args?: unknown): CheckResult {
    this.callCount++;
    const signature = buildToolSignature(toolName, args);
    this.callHistory.push(signature);
    if (this.callHistory.length > ToolCallCircuitBreaker.MAX_HISTORY) {
      this.callHistory.shift();
    }
    this.updateConsecutive(signature);

    const result = this.evaluate(signature);
    this.lastCheckResult = result;
    return result;
  }

  /** 更新连续相同签名计数 */
  private updateConsecutive(signature: string): void {
    if (signature === this.lastSignature) {
      this.consecutiveCount++;
    } else {
      this.consecutiveCount = 1;
      this.lastSignature = signature;
    }
  }

  /** 按优先级评估规则；steer 触发满 maxRepeatAfterWarning 次升级为 terminate */
  private evaluate(signature: string): CheckResult {
    const result = this.checkConsecutive(signature)
      ?? this.checkSlidingWindow()
      ?? { blocked: false, action: "allow" as const };

    if (result.action === "allow") {
      this.steerStrikes = 0;
      return result;
    }
    if (result.action === "steer") {
      this.steerStrikes++;
      if (this.steerStrikes > this.config.maxRepeatAfterWarning) {
        this.logCircuitBreak("ignored_steer");
        return {
          blocked: true,
          reason: `Force terminated: ${this.steerStrikes} steers ignored (last: ${result.reason})`,
          action: "terminate",
          trigger: "ignored_steer",
        };
      }
    }
    return result;
  }

  /** B-3: 连续相同行为检查（按签名，同名工具不同行为不计） */
  private checkConsecutive(signature: string): CheckResult | null {
    if (this.consecutiveCount <= this.config.maxConsecutiveIdentical) return null;
    return { blocked: true, reason: `Consecutive identical call "${signature}" ${this.consecutiveCount} times. Break the pattern.`, action: "steer" };
  }

  /** B-3b: 滑动窗口跨工具交替循环检查 */
  private checkSlidingWindow(): CheckResult | null {
    if (!detectSlidingWindowRepeat(this.callHistory, this.config.slidingWindowSize, this.config.slidingWindowRepeat)) return null;
    return { blocked: true, reason: `Repeating tool call pattern detected in sliding window (K=${this.config.slidingWindowSize}, M=${this.config.slidingWindowRepeat}). Break the cycle.`, action: "steer" };
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
