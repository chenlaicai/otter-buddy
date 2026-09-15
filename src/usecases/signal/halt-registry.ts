/**
 * Halt 指令注册表（F20260826mwrd C1；#927 生命周期加固）。
 *
 * 内存态打标：halt_otter 工具 mark → 目标獭下一次 tool_call 边界被 block（takeForBlock）
 * → 该 invoke 余下生命周期持续 block（防 LLM 无视指令继续调工具）→ invoke 结束 endInvoke 清理。
 *
 * #927 halt 生命周期语义（治跨世代残留）：
 * - **invoke 作用域**：halt 的送达目标是「目标獭的下一个工具调用边界」，送达后持续 block
 *   到该 invoke 结束为止。endInvoke 同时清 pending + active——被 halt 獭合规响应
 *   （speak 报告 + 停止发起调用）后 invoke 自然结束，halt 使命完成，改派的新 invoke
 *   不应再被旧指令拦截（跨世代残留 = 目标獭所有工具调用被拦，只能发 blocked 求救）。
 * - **pending TTL（30 分钟）**：打标后目标獭长时间未被唤醒（如对话静默）时，指令挂而不化。
 *   惰性过期：takeForBlock/isHalted 读取时检查 issuedAt，超时即丢弃——无 timer 成本，
 *   进程重启自然归零。30 分钟 = 「大獭打标后目标獭理应在数分钟内到达工具调用边界」
 *   的宽松上限；超时后仍需停手，大獭重发一次即可（halt_otter 幂等打标）。
 * - **unhalt_otter 解除路径**：大獭误 halt（如 halt 错目标）时立即清除，
 *   不等 TTL 自然过期。
 *
 * 持久化不在本模块（signal_events 落账由调用方负责）：halt 打标→落账在 halt_otter 工具内，
 * 首次注入→落账更新由 extension handler 闭包（model-runtime-registry）执行。
 *
 * 进程级单例：单进程服务 + scheduler 同进程（ensureHealingScheduler 模式），无跨进程需求。
 */

/** pending 态 halt 指令的存活上限（ms）。超时未送达即惰性失效（#927）。 */
export const HALT_PENDING_TTL_MS = 30 * 60 * 1000;

/** 一条 halt 指令 */
export interface HaltDirective {
  /** signal_events 落账 id（mark 与首次注入落账更新共用） */
  id: string;
  targetOtterId: string;
  fromOtterId: string;
  fromOtterName: string;
  conversationId: string;
  reason: string;
  issuedAt: string;
}

/** 首次注入回调（extension handler 注册：更新 signal_events 落账 + 日志） */
export type HaltFirstBlockCallback = (directive: HaltDirective) => void;

class HaltRegistry {
  /** 待消费指令（targetOtterId → 队列，halt_otter 连续打标时累积） */
  private pending = new Map<string, HaltDirective[]>();
  /** 当前 invoke 已注入过 block 的指令（持续 block 直到 endInvoke） */
  private active = new Map<string, HaltDirective[]>();
  private firstBlockCallback: HaltFirstBlockCallback | null = null;

  /** 打标：目标獭下一次工具调用边界生效 */
  mark(directive: HaltDirective): void {
    const list = this.pending.get(directive.targetOtterId) ?? [];
    list.push(directive);
    this.pending.set(directive.targetOtterId, list);
  }

  /** pending 惰性过期：丢弃 issuedAt 超过 TTL 的指令（#927）。
   *  在 takeForBlock / isHalted / peekPending 读取路径上调用——无 timer，读取即清扫。 */
  private sweepExpired(now = Date.now()): void {
    for (const [otterId, list] of this.pending) {
      const alive = list.filter(d => now - Date.parse(d.issuedAt) < HALT_PENDING_TTL_MS);
      if (alive.length === list.length) continue;
      if (alive.length === 0) this.pending.delete(otterId);
      else this.pending.set(otterId, alive);
    }
  }

  /**
   * tool_call handler 调用：取当前应 block 的指令。
   * 首次从 pending 移入 active（触发 firstBlock 回调），后续从 active 读取
   * （同一 invoke 内 LLM 再试调工具 → 再 block，直到它报告并 yield）。
   */
  takeForBlock(targetOtterId: string): HaltDirective[] {
    this.sweepExpired();
    if (!this.active.has(targetOtterId)) {
      const list = this.pending.get(targetOtterId);
      if (!list || list.length === 0) return [];
      this.pending.delete(targetOtterId);
      this.active.set(targetOtterId, list);
      for (const d of list) {
        try { this.firstBlockCallback?.(d); } catch { /* 回调失败不阻断 block 本身 */ }
      }
    }
    return this.active.get(targetOtterId) ?? [];
  }

  /** 目标獭是否有 halt 待消费或持续生效（halt_otter 工具回显 + UI 状态用） */
  isHalted(targetOtterId: string): boolean {
    this.sweepExpired();
    return this.pending.has(targetOtterId) || this.active.has(targetOtterId);
  }

  /** 非破坏性查看待消费指令（测试/回显用） */
  peekPending(targetOtterId: string): HaltDirective[] {
    this.sweepExpired();
    return [...(this.pending.get(targetOtterId) ?? [])];
  }

  /** invoke 生命周期结束（session dispose）清理该獭全部 halt 状态（#927：pending 一并清）。
   *  halt 是 invoke 作用域指令：已送达（active）随 invoke 结束完成使命；
   *  未送达（pending）的指令挂在本 invoke 边界外无消费对象——跨 invoke 保留只会形成
   *  世代残留（新 invoke 第一个工具调用即被拦），清掉。仍需停手，大獭重发。 */
  endInvoke(targetOtterId: string): void {
    this.pending.delete(targetOtterId);
    this.active.delete(targetOtterId);
  }

  /** #927：显式解除（unhalt_otter 工具）。返回被清除的 pending 指令（供台账落账）。 */
  clear(targetOtterId: string): HaltDirective[] {
    const clearedPending = this.pending.get(targetOtterId) ?? [];
    this.pending.delete(targetOtterId);
    this.active.delete(targetOtterId);
    return clearedPending;
  }

  /** 首次注入回调注册（extension handler 装配时调用） */
  onFirstBlock(cb: HaltFirstBlockCallback): void {
    this.firstBlockCallback = cb;
  }

  /** 测试隔离：清空全部状态 */
  resetForTest(): void {
    this.pending.clear();
    this.active.clear();
    this.firstBlockCallback = null;
  }
}

/** 进程级单例（跨模块共享：halt_otter 工具写、extension handler 读） */
export const haltRegistry = new HaltRegistry();
