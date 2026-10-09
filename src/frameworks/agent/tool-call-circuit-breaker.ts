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
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  maxConsecutiveIdentical: 5,
  maxRepeatAfterWarning: 5,
  maxPerEventTimeMs: 600_000,
  slidingWindowSize: 6,
  slidingWindowRepeat: 3,
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

/** 实体工具签名：工具名 + 实体标识；标识缺失时退回工具名（连续缺参被 steer 是合理纠错信号）。F20260826d464 先例泛化（#475） */
function entityToolSignature(toolName: string, key: string, value: unknown): string {
  return typeof value === "string" && value ? `${toolName}: ${value}` : toolName;
}

/** Otter 管理工具签名：dissolve/restart 取 otterId；create 取 name。F20260826d464 */
function otterToolSignature(toolName: string, a: Record<string, unknown>): string | null {
  if (toolName === "dissolve_otter" || toolName === "restart_otter") {
    return entityToolSignature(toolName, "otterId", a.otterId);
  }
  if (toolName === "create_otter") {
    return entityToolSignature(toolName, "name", a.name);
  }
  return null;
}

function pushIfString(parts: string[], value: unknown): void {
  if (typeof value === "string" && value) parts.push(value);
}

function pushIfPrefixed(parts: string[], prefix: string, value: unknown): void {
  if (typeof value === "string" && value) parts.push(`${prefix}:${value}`);
}

/** eventIds 直拼上限：超出收敛为「前 N + 计数 + 指纹」（与 get_memory_detail >2 摘要同构），防 100 ID 直拼进 steer 文本与 warn 日志 */
const HEALING_EVENT_IDS_INLINE_MAX = 5;

/**
 * 收集 manage_healing_events 的过滤特征（行为维度）。
 * query 侧旋钮（status/errorType/includeProbe）不入签名——查询旋钮非实体标识，
 * 同 action 连发正是卡壳语义（特性文档 2.3 设计决策，F20261009tspg）。
 */
function healingFilterParts(a: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if (Array.isArray(a.eventIds)) {
    const ids = a.eventIds.filter((x): x is string => typeof x === "string" && Boolean(x));
    if (ids.length > HEALING_EVENT_IDS_INLINE_MAX) {
      const rest = ids.length - HEALING_EVENT_IDS_INLINE_MAX;
      const head = ids.slice(0, HEALING_EVENT_IDS_INLINE_MAX).join(",");
      parts.push(`${head},+${rest}#${contentDigest(ids.join(","))}`);
    } else {
      parts.push(...ids);
    }
  }
  // bound:N 是 batch_resolve 收尾过滤；issue:N 是 batch_bind 归口目标——两个不同参数不同前缀，避免同值混淆
  if (typeof a.filterBoundIssue === "number" && Number.isFinite(a.filterBoundIssue)) {
    parts.push(`bound:${a.filterBoundIssue}`);
  }
  if (typeof a.issueNumber === "number" && Number.isFinite(a.issueNumber)) {
    parts.push(`issue:${a.issueNumber}`);
  }
  pushIfString(parts, a.filterRuleId);
  pushIfString(parts, a.filterErrorType);
  pushIfPrefixed(parts, "status", a.filterStatus);
  pushIfPrefixed(parts, "sev", a.filterSeverity);
  pushIfPrefixed(parts, "before", a.filterCreatedBefore);
  pushIfPrefixed(parts, "after", a.filterCreatedAfter);
  return parts;
}

/**
 * manage_healing_events 签名：action + 过滤特征（行为维度）。
 * 同一 action 不同过滤特征不算重复（resolve 不同 event / bind 到不同 issue /
 * 按不同时间窗分批都是不同操作）；无过滤特征时同 action 连发保留兜底——
 * query 连发正是卡壳语义（#475）。
 * 已知限制（特性文档 2.3）：truncated=true 续跑是协议规定的合法重复，同签名累计；
 * 跨调用批次状态会破坏签名无状态性，接受该限制。
 */
function healingEventsSignature(a: Record<string, unknown>): string {
  const action = typeof a.action === "string" && a.action ? a.action : "";
  const parts = healingFilterParts(a);
  if (!action && parts.length === 0) return "manage_healing_events";
  return parts.length > 0
    ? `manage_healing_events: ${action} [${parts.join(",")}]`
    : `manage_healing_events: ${action}`;
}

function haltOtterSignature(toolName: string, a: Record<string, unknown>): string {
  const id = typeof a.otterId === "string" && a.otterId
    ? a.otterId
    : (typeof a.otterName === "string" && a.otterName ? a.otterName : "");
  return entityToolSignature(toolName, "otterId|otterName", id);
}

function mergePrSignature(a: Record<string, unknown>): string {
  const pr = a.prNumber;
  if (typeof pr === "number" && Number.isFinite(pr)) return `merge_pr: ${pr}`;
  if (typeof pr === "string" && pr) return `merge_pr: ${pr}`;
  return "merge_pr";
}

function memoryDetailSignature(a: Record<string, unknown>): string {
  if (Array.isArray(a.ids) && a.ids.length > 0) {
    const ids = a.ids.filter((x): x is string => typeof x === "string" && Boolean(x));
    if (ids.length > 0) {
      return ids.length <= 2
        ? `get_memory_detail: ${ids.join(",")}`
        : `get_memory_detail: ${ids.length}#${contentDigest(ids.join("\n"))}`;
    }
  }
  return "get_memory_detail";
}

function registerMatterSignature(a: Record<string, unknown>): string {
  const title = typeof a.title === "string" ? a.title : "";
  return title ? `register_matter#${contentDigest(title)}` : "register_matter";
}

/**
 * 带实体参数的管理工具签名（#475，F20260826d464 先例泛化）：
 * 批量操作不同实体（合入不同 PR、halt 不同 otter、迁移不同 matter、查不同消息/记忆）
 * 不算重复；同一实体连续操作才累计。标识缺失时退回工具名。
 * 设计哲学（F20260728cbwt）：签名只取「行为」（实体标识），忽略无关参数值。
 */
function managementToolSignature(toolName: string, a: Record<string, unknown>): string | null {
  switch (toolName) {
    case "merge_pr":
      return mergePrSignature(a);
    case "halt_otter":
    case "unhalt_otter":
      return haltOtterSignature(toolName, a);
    case "transition_matter":
      return entityToolSignature(toolName, "matter_id", a.matter_id);
    case "get_message":
      return entityToolSignature(toolName, "messageId", a.messageId);
    case "get_memory_detail":
      return memoryDetailSignature(a);
    case "get_related":
      return entityToolSignature(toolName, "entry_id", a.entry_id);
    case "manage_healing_events":
      return healingEventsSignature(a);
    case "register_matter":
      return registerMatterSignature(a);
    default:
      return null;
  }
}

/**
 * 构建工具调用的行为签名（"连续相同"的判据）。
 * 同名工具不同行为不算重复：bash 看命令词、read 看目标路径、edit/write 看路径+内容指纹；
 * 真正的卡壳（同一命令反复失败、同一编辑反复重试、反复读同一文件）才会累计。
 *
 * F20260820d338：speak 加入 body 内容指纹——连续 speak 不同内容不算重复，
 * 同一 speak 内容反复输出才累计（与 write/edit 同理）。
 * F20261009tspg：出口统一 capSignature——签名会注入 steer 提示与 warn 日志，
 * 任何路径的超长签名（如 100 eventIds）收敛为截断+指纹。
 */
export function buildToolSignature(toolName: string, args?: unknown): string {
  return capSignature(rawToolSignature(toolName, args));
}

/** 签名长度上限：触发 steer 时签名注入 LLM 纠正提示，卡壳时 token 最不该浪费 */
const SIGNATURE_MAX_LENGTH = 200;

function capSignature(sig: string): string {
  if (sig.length <= SIGNATURE_MAX_LENGTH) return sig;
  return `${sig.slice(0, SIGNATURE_MAX_LENGTH - 12)}#…${contentDigest(sig)}`;
}

function rawToolSignature(toolName: string, args?: unknown): string {
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
  const otterSig = otterToolSignature(toolName, a);
  if (otterSig !== null) return otterSig;
  // #475：带实体参数的管理工具签名——批量管理操作不同实体不算重复（merge_pr/halt/transition 等）
  const mgmtSig = managementToolSignature(toolName, a);
  if (mgmtSig !== null) return mgmtSig;
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
