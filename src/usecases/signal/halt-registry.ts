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
 * - **打标前活跃性检查（halt_otter 工具内）**：halt 的送达语义是「目标獭下一个工具调用
 *   边界」，消费对象是进行中的 invoke——endInvoke 挂 invoke finally，行动结束必清 pending。
 *   因此打标时目标不在执行中 = 指令无消费对象，直接拒绝打标（引导改派或等开工再打），
 *   从入口杜绝孤儿指令。这是 chen 的架构裁决（#927 PR 终审）：设计不留模糊区，
 *   不用 TTL 兜底——TTL 能防"挂而不化"，但本质是时间窗兜底，前置检查才是根治。
 * - **unhalt_otter 解除路径**：大獭误 halt（如 halt 错目标）时立即清除，完备性保证。
 *
 * 持久化不在本模块（signal_events 落账由调用方负责）：halt 打标→落账在 halt_otter 工具内，
 * 首次注入→落账更新由 extension handler 闭包（model-runtime-registry）执行。
 *
 * 进程级单例：单进程服务 + scheduler 同进程（ensureHealingScheduler 模式），无跨进程需求。
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

  /** invoke 生命周期结束（session dispose）清理该獭全部 halt 状态（#927：pending 一并清）。
   *  halt 是 invoke 作用域指令：已送达（active）随 invoke 结束完成使命；
   *  未送达（pending）的指令挂在本 invoke 边界外无消费对象——跨 invoke 保留只会形成
   *  世代残留（新 invoke 第一个工具调用即被拦），清掉。仍需停手，大獭重发。 */
  endInvoke(targetOtterId: string): void {
    this.pending.delete(targetOtterId);
    this.active.delete(targetOtterId);
  }

  /** #927：显式解除（unhalt_otter 工具）。返回被清除的两态指令（pending 供台账 dismiss 落账，active 供回显计数）。 */
  clear(targetOtterId: string): { pending: HaltDirective[]; active: HaltDirective[] } {
    const cleared = {
      pending: this.pending.get(targetOtterId) ?? [],
      active: this.active.get(targetOtterId) ?? [],
    };
    this.pending.delete(targetOtterId);
    this.active.delete(targetOtterId);
    return cleared;
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
