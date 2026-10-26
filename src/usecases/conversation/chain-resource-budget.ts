import type { Logger } from "@usecases/ports/logger";
import type { AgentMetricsPort } from "@usecases/ports/agent-metrics-port";
import type { HealingEventRepository } from "@usecases/healing/healing-event-repository";
import { healingAlertRegistry } from "@usecases/healing/healing-alert-registry";
import type { HealingEvent } from "@entities/healing/healing-event";
import { randomUUID } from "node:crypto";
import { totalTokenUsage, type TokenUsage } from "./token-usage";

export type ChainStopReason = "token_budget" | "stalled_cycle" | "hard_depth";
export interface ChainStop {
  reason: ChainStopReason;
  depth: number;
  totalTokens: number;
  pendingTargets: string[];
  detail?: string;
  healingEventId?: string;
}
export interface ChainHopActivity {
  depth: number;
  pendingTargets: string[];
  usageDeltas?: TokenUsage[];
  transitions?: Array<{ from: string; to: string }>;
}
interface ChainResourceBudgetOptions {
  logger: Logger;
  conversationId: string;
  metrics?: AgentMetricsPort;
  healingRepo?: HealingEventRepository;
  maxChainTokens?: number;
  chainDepthSoftLimit?: number;
  maxChainDepth?: number;
  stalledCycleHopLimit?: number;
}

function limit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** Two consecutive copies prove a cycle; a single A→B→A alone is not enough. */
function findRepeatedCycle(edges: string[]): string[] | undefined {
  for (let period = 1; period <= Math.min(8, Math.floor(edges.length / 2)); period++) {
    const cycle = edges.slice(-period);
    if (cycle.join("\0") === edges.slice(-period * 2, -period).join("\0")) return cycle;
  }
  return undefined;
}

/** Per-chain, in-memory resource boundary. No DB/background lifecycle; the chain owns its disposal. */
export class ChainResourceBudget {
  private totalTokens = 0;
  private stalledHops = 0;
  private softDepthNotified = false;
  private readonly edges: string[] = [];
  private readonly maxTokens: number;
  private readonly softDepth: number;
  private readonly maxDepth: number;
  private readonly stalledLimit: number;
  private cycleWarned = false;
  private activeCycle?: string[];
  private cyclePosition = 0;
  private readonly healingWrites: Promise<void>[] = [];

  constructor(private readonly deps: ChainResourceBudgetOptions) {
    this.maxTokens = limit(deps.maxChainTokens, 10_000_000);
    this.softDepth = limit(deps.chainDepthSoftLimit, 100);
    this.maxDepth = limit(deps.maxChainDepth, 2_000);
    this.stalledLimit = limit(deps.stalledCycleHopLimit, 20);
  }

  /** Stop BEFORE another LLM call when the previous hop exhausted a resource boundary. */
  beforeHop(depth: number, pendingTargets: string[]): ChainStop | undefined {
    if (this.totalTokens >= this.maxTokens) return this.stop("token_budget", depth, pendingTargets, `累计 ${this.totalTokens} / 预算 ${this.maxTokens} token`);
    if (depth >= this.maxDepth) return this.stop("hard_depth", depth, pendingTargets, `达到最终深度 ${this.maxDepth}`);
    if (depth >= this.softDepth && !this.softDepthNotified) {
      this.softDepthNotified = true;
      this.deps.logger.warn("发言链达到软深度，继续执行并观测资源", { conversationId: this.deps.conversationId, depth, pendingTargets, totalTokens: this.totalTokens });
      try { this.deps.metrics?.recordChainSoftDepth(); } catch { /* metrics never break dispatch */ }
      this.healingWrites.push(this.recordHealing("medium", `发言链达到软深度 ${depth}，仍在 token 预算内继续执行`, { chainSoftDepth: depth, pendingTargets, totalTokens: this.totalTokens }));
    }
    return undefined;
  }

  afterHop(activity: ChainHopActivity): ChainStop | undefined {
    const beforeTokens = this.totalTokens;
    this.totalTokens += (activity.usageDeltas ?? []).reduce((sum, usage) => sum + totalTokenUsage(usage), 0);
    const repeated = this.observeTransitions(activity.transitions ?? []);
    const hasUsage = (activity.usageDeltas ?? []).length > 0;
    const hasActivity = this.totalTokens > beforeTokens;
    if (repeated && !this.cycleWarned) {
      this.cycleWarned = true;
      this.deps.logger.warn("发言链检测到重复回路（仅观测，不据此单独停止）", { conversationId: this.deps.conversationId, depth: activity.depth, edges: [...this.edges] });
    }
    if (!repeated) this.cycleWarned = false;
    // Missing telemetry is not proof of semantic stagnation; only explicit zero-delta cycles qualify.
    this.stalledHops = repeated && hasUsage && !hasActivity ? this.stalledHops + 1 : 0;
    if (this.stalledHops >= this.stalledLimit) {
      return this.stop("stalled_cycle", activity.depth, activity.pendingTargets, `重复回路连续 ${this.stalledHops} 跳无可计量 token 活动`);
    }
    return undefined;
  }

  /** Raw history discovers a repeated suffix; activeCycle preserves its phase across window trimming. */
  private observeTransitions(transitions: Array<{ from: string; to: string }>): boolean {
    let repeated = false;
    for (const transition of transitions) {
      const edge = `${transition.from}->${transition.to}`;
      if (this.activeCycle && edge === this.activeCycle[this.cyclePosition]) {
        this.cyclePosition = (this.cyclePosition + 1) % this.activeCycle.length;
        repeated = true;
        continue;
      }
      this.activeCycle = undefined;
      this.cyclePosition = 0;
      this.edges.push(edge);
      if (this.edges.length > 16) this.edges.splice(0, this.edges.length - 16);
      const cycle = findRepeatedCycle(this.edges);
      if (cycle) {
        this.activeCycle = cycle;
        this.cyclePosition = this.edges.length % cycle.length;
        repeated = true;
      }
    }
    return repeated;
  }

  async finish(depth: number): Promise<void> {
    await Promise.all(this.healingWrites);
    try {
      this.deps.metrics?.recordChainHops(depth);
      this.deps.metrics?.recordChainTokenUsage(this.totalTokens);
    } catch { /* metrics never break dispatch */ }
  }

  private stop(reason: ChainStopReason, depth: number, pendingTargets: string[], detail: string): ChainStop {
    const stop: ChainStop = { reason, depth, totalTokens: this.totalTokens, pendingTargets, detail };
    this.deps.logger.warn("发言链资源边界触发，停止后续派发", { conversationId: this.deps.conversationId, ...stop });
    try {
      this.deps.metrics?.recordChainStopped(reason);
      if (reason === "hard_depth") this.deps.metrics?.recordChainDepthExceeded();
    } catch { /* metrics never break dispatch */ }
    this.healingWrites.push(this.recordHealing(reason === "stalled_cycle" ? "medium" : "high", `发言链停止：${detail}；未派发目标 ${pendingTargets.join(", ") || "无"}`, { chainStop: stop }, stop));
    return stop;
  }

  private async recordHealing(severity: "medium" | "high", description: string, context: Record<string, unknown>, stop?: ChainStop): Promise<void> {
    if (!this.deps.healingRepo) return;
    try {
      const event: HealingEvent = {
        id: randomUUID(), messageId: randomUUID(), conversationId: this.deps.conversationId, otterId: "system",
        errorType: "circuit_break", severity, description,
        suggestion: "查看 chainStop 的原因、深度、token 与 pendingTargets；需要继续时由搭档发起新链。",
        context: { conversationId: this.deps.conversationId, ...context },
        status: "open", resolution: null, createdAt: new Date().toISOString(), resolvedAt: null,
      };
      await this.deps.healingRepo.create(event);
      if (stop) stop.healingEventId = event.id;
      if (severity === "high") {
        healingAlertRegistry.enqueue(this.deps.conversationId, { eventId: event.id, conversationId: this.deps.conversationId, otterId: "system", errorType: "circuit_break", description, createdAt: event.createdAt });
      }
    } catch (error) {
      this.deps.logger.warn("发言链 healing 记录失败（不阻断停止）", { conversationId: this.deps.conversationId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
