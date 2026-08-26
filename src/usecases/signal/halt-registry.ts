/**
 * Halt 指令注册表（F20260826mwrd C1）。
 *
 * 内存态打标：halt_otter 工具 mark → 目标獭下一次 tool_call 边界被 block（takeForBlock）
 * → 该 invoke 余下生命周期持续 block（防 LLM 无视指令继续调工具）→ invoke 结束 endInvoke 清理。
 *
 * 持久化不在本模块（signal_events 落账由调用方负责）：halt 打标→落账在 halt_otter 工具内，
 * 首次注入→落账更新由 extension handler 闭包（model-runtime-registry）执行。
 *
 * 进程级单例：单进程服务 + scheduler 同进程（ensureHealingScheduler 模式），无跨进程需求。
 * 进程重启丢标的代价：目标獭 halt 未消费即进程重启——极低概率，后果=大獭重发一次，接受
 * （signal_events 中该条停留 pending，恰好是「未执行」的审计证据）。
 */

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

  /**
   * tool_call handler 调用：取当前应 block 的指令。
   * 首次从 pending 移入 active（触发 firstBlock 回调），后续从 active 读取
   * （同一 invoke 内 LLM 再试调工具 → 再 block，直到它报告并 yield）。
   */
  takeForBlock(targetOtterId: string): HaltDirective[] {
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
    return this.pending.has(targetOtterId) || this.active.has(targetOtterId);
  }

  /** 非破坏性查看待消费指令（测试/回显用） */
  peekPending(targetOtterId: string): HaltDirective[] {
    return [...(this.pending.get(targetOtterId) ?? [])];
  }

  /** invoke 生命周期结束（session dispose）清理持续 block 状态——改派后新 invoke 不受旧 halt 影响 */
  endInvoke(targetOtterId: string): void {
    this.active.delete(targetOtterId);
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
