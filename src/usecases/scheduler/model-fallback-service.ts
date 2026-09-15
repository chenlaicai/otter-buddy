/**
 * 模型限流降级器（#843，F20260915mfbk）。
 *
 * 背景：配额型 429（code 1310，周/月上限，重置以天计）下定时任务绑定单一模型 =
 * 该任务当天全灭（9-08 现场：daily-review 无产出、self-healing 需人工「再来」）。
 * #543 已做告警层（healing 落账 + C3 队列），#886 重构移除了限流熔断分支——
 * 本模块补执行层：exhausted 429 触发时自动切 fallback 模型，重置后自动回切。
 *
 * 设计：
 * - 降级登记（register）：orchestrator 检出 exhausted 时调用。同 otter 重复登记
 *   幂等（更新 resetAt，不叠链）。fallback 链按序取第一个 ≠ 当前模型的可用别名；
 *   链耗尽返回 null（调用方落 high healing + 跳过本次执行，不静默失败）。
 * - 降级解析（resolve）：invoke 路径在「otter 无显式 modelAlias 或显式别名已降级」时
 *   读取降级别名。显式配置优先于降级（用户意图 > 自动兜底）——不对，反转：
 *   降级状态下显式别名 == 被降级别名时必须返回 fallback（否则降级无效）。语义：
 *   resolve(rawAlias) 返回 rawAlias 未被降级时的原值或降级后的替身。
 * - 自动回切：内存定时器（resetAt - now，上限 24h 防漂移长定时）+ 启动时扫描
 *   过期项即刻清除（进程重启丢内存态 = 回到无降级现状，安全侧）。
 * - 不落库：降级是运行时态，重启即回原模型（同 F20260824srst 闸门的生命周期
 *   设计——最坏情况回到现状，不引入持久一致性负担）。
 *
 * Why 不直接改 otter_configs.modelAlias：那是用户意图的持久真相源，自动机制
 * 改写会污染「搭档配置了什么」的语义；降级是叠加层，resolve 时合成。
 */
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";

/** 单个 otter 的降级状态 */
interface DegradationEntry {
  /** 被降级的模型别名（原始） */
  fromAlias: string;
  /** 降级使用的 fallback 别名 */
  toAlias: string;
  /** 原模型配额重置时间（ms epoch）；到点自动回切 */
  resetAt: number;
  /** 登记时间（ms epoch，观测用） */
  registeredAt: number;
  /** 回切定时器句柄 */
  timer?: ReturnType<typeof setTimeout>;
}

/** 全局 fallback 链（默认值；后续可接配置） */
const DEFAULT_FALLBACK_CHAIN = ["kimi", "mimo", "glm", "glm-flash"] as const;

/** 回切定时器漂移上限：24h（防 resetHint 解析出超远时间挂长定时器） */
const MAX_REVERT_DELAY_MS = 24 * 60 * 60 * 1000;

export class ModelFallbackService {
  private degradations = new Map<string, DegradationEntry>();
  private readonly logger: Pick<Console, "info" | "warn">;

  constructor(
    private readonly modelPool: Pick<ModelPoolLike, "getDefaultAlias" | "hasModel">,
    logger?: Pick<Console, "info" | "warn">,
    private readonly fallbackChain: readonly string[] = DEFAULT_FALLBACK_CHAIN,
  ) {
    this.logger = logger ?? console;
  }

  /**
   * 登记降级：exhausted 429 时调用。
   * @returns 降级目标别名；fallback 链耗尽（无可用替身）返回 null——调用方应
   *          落 high healing 并跳过执行，不静默失败。
   */
  register(otterId: string, exhaustedAlias: string, resetHint?: string | null): string | null {
    const fallback = this.pickFallback(exhaustedAlias);
    if (fallback === null) return null;

    const resetAt = this.parseResetAt(resetHint) ?? Date.now() + 60 * 60 * 1000; // 解析失败 1h 后回切重试
    const existing = this.degradations.get(otterId);
    if (existing?.timer) clearTimeout(existing.timer);

    const entry: DegradationEntry = {
      fromAlias: exhaustedAlias,
      toAlias: fallback,
      resetAt,
      registeredAt: Date.now(),
    };
    entry.timer = setTimeout(() => this.revert(otterId), Math.min(resetAt - Date.now(), MAX_REVERT_DELAY_MS));
    if (typeof entry.timer === "object" && "unref" in entry.timer) entry.timer.unref?.();
    this.degradations.set(otterId, entry);
    this.logger.info("[model-fallback] degraded", {
      otterId, from: exhaustedAlias, to: fallback, resetAt: new Date(resetAt).toISOString(),
    });
    return fallback;
  }

  /**
   * 解析 invoke 应使用的模型别名。
   * @param rawAlias otter 配置的显式别名（可能 undefined = 跟默认）
   * @returns 降级生效中的替身别名；未降级返回 null（调用方维持原语义）
   */
  resolve(otterId: string, rawAlias?: string): string | null {
    const entry = this.degradations.get(otterId);
    if (!entry) return null;
    // 仅当「当前生效别名 == 被降级别名」时返回替身：
    // - 显式配置 = 被降级别名 → 降级（否则降级对显式配置无效）
    // - 无显式配置且默认 = 被降级别名 → 降级
    // - 显式配置 = 其他别名（用户已手动换模型）→ 不干预（尊重手动决策）
    const effective = rawAlias ?? this.modelPool.getDefaultAlias();
    return effective === entry.fromAlias ? entry.toAlias : null;
  }

  /** 回切（定时器触发或外部显式调用）。幂等。 */
  revert(otterId: string): void {
    const entry = this.degradations.get(otterId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.degradations.delete(otterId);
    this.logger.info("[model-fallback] reverted", {
      otterId, from: entry.fromAlias, to: entry.toAlias, at: new Date().toISOString(),
    });
  }

  /** 启动扫描：清除过期降级（进程重启后定时器丢失的兜底）。幂等。 */
  sweepExpired(): void {
    const now = Date.now();
    for (const [otterId, entry] of this.degradations) {
      if (now >= entry.resetAt) this.revert(otterId);
    }
  }

  /** 观测接口（healing context / 测试用） */
  getDegradation(otterId: string): { fromAlias: string; toAlias: string; resetAt: number } | null {
    const e = this.degradations.get(otterId);
    return e ? { fromAlias: e.fromAlias, toAlias: e.toAlias, resetAt: e.resetAt } : null;
  }

  /** fallback 链按序取第一个 ≠ exhausted 且池内存在的别名 */
  private pickFallback(exhaustedAlias: string): string | null {
    for (const alias of this.fallbackChain) {
      if (alias === exhaustedAlias) continue;
      if (this.modelPool.hasModel(alias)) return alias;
    }
    return null;
  }

  /** 解析 resetHint（中文时间字符串，如「2026-09-14 19:31:23 重置」） */
  private parseResetAt(resetHint?: string | null): number | null {
    if (!resetHint) return null;
    const m = resetHint.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    if (!m) return null;
    const t = Date.parse(`${m[1]}T${m[2]}+08:00`); // 智谱时间戳为东八区
    return Number.isFinite(t) ? t : null;
  }
}
