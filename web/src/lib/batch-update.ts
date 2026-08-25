import type { LocalMessage } from './mappers'

/**
 * 消息批量更新器（F20260814qswp）。
 *
 * 旧实现缺陷：batchUpdateMessages 在 setAllMessages 的 updater 内执行业务 updater
 * 并返回 prev（state 永不变），导致同一 50ms 窗口内的后续 updater 读到的永远是
 * 原始列表——窗口内中间更新全部丢失（message.start 占位 + 同窗口 assistant_text
 * 的文本段直接消失）。副作用（写 pendingUpdatesRef、起 timer）写在 React state
 * updater 内也违反 updater 纯函数约定。
 *
 * 新语义：update() 调用时**立即**对暂存副本（pending 或 getBase 提供的镜像）执行
 * updater（调用方可依赖闭包标志位模式，如 added 计数）；窗口到期 flush 产出
 * materialize 闭包，由 apply 在 **React setState 函数式 updater 内**调用——
 * 传入的 current 是 React 更新队列的最新值（可能比 getBase 镜像新：镜像在
 * passive effect 中同步，存在 commit→effect 间隙，二轮审视证明在 flush 外做
 * 引用比较会漏检该间隙内的外部写入）。
 *
 * 演进史：
 * - 一轮修复引入"暂存副本 + pending 优先"→ 被对抗审视抓到双轨覆盖回归（窗口内
 *   直接 setAllMessages 写入被旧暂存整体抹掉）。
 * - 二轮修复加"baseRef 引用快照 + flush 时重放 updater 链"→ 又被抓到镜像滞后
 *   盲区（上述 commit→effect 间隙）与累积型 updater 重放重复问题。
 * - 三轮（当前）：检测/重放移入 apply 的函数式 updater 内（current=队列真实值，
 *   引用比较无盲区）；累积型 updater 的重复问题在消费方解决（index.tsx 的
 *   assistant_text 改"按 messageId 累积 + 全量 set"幂等语义，重放安全）。
 *
 * 要求 updater 是纯函数（list → list，无闭包外副作用）——现有全部调用点满足。
 */
export interface MessageBatcherOptions {
  /** 合并窗口毫秒数 */
  windowMs: number
  /** 读取某会话当前消息列表（state 的同步镜像，如 ref；仅用于 update() 时的 eager
   *  staging（added 标志等闭包语义），最终一致性由 apply 内的 materialize 保证） */
  getBase: (convId: string) => LocalMessage[]
  /** 窗口到期：在 setAllMessages 的函数式 updater 内对每个会话调用 materialize，
   *  用返回值更新 state。materialize(current) 语义：current 与 staging 基线同引用
   *  → 直接返回暂存结果；否则把 updater 链重放到 current（外部写入保留） */
  apply: (updates: ReadonlyMap<string, (current: LocalMessage[] | undefined) => LocalMessage[]>) => void
  /** F20260825scrf：返回 true 时暂停 flush（窗口到期也不产出）——弹窗打开期间冻结
   *  scrim 背后像素（backdrop-filter 闪烁根治，见特性文档）。暂存链完整保留，
   *  调用方在解冻时机手动 flush() 追上，流式更新零丢失 */
  getShouldDefer?: () => boolean
}

interface PendingChain {
  /** staging 开始时 getBase 返回的引用 */
  baseRef: LocalMessage[]
  /** 按序暂存的 updater 链（flush 重放用） */
  updaters: Array<(prev: LocalMessage[]) => LocalMessage[]>
  /** 对暂存副本链式执行的结果（基线未变时直接应用） */
  staged: LocalMessage[]
}

export class MessageBatcher {
  private pending = new Map<string, PendingChain>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: MessageBatcherOptions) {}

  /** 对暂存副本同步执行 updater；有实际变更时暂存并启动合并窗口。
   *  no-op（updater 返回相同引用）不留链、不进 pending、不起 timer */
  update(convId: string, updater: (prev: LocalMessage[]) => LocalMessage[]): void {
    let chain = this.pending.get(convId)
    if (!chain) {
      const base = this.opts.getBase(convId)
      chain = { baseRef: base, updaters: [], staged: base }
    }
    const updated = updater(chain.staged)
    if (updated === chain.staged) return
    chain.staged = updated
    chain.updaters.push(updater)
    this.pending.set(convId, chain)
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.opts.windowMs)
    }
  }

  /** 立即产出全部暂存更新的 materialize 闭包并交给 apply（窗口到期时调用）。
   *  materialize 必须在 React setState 的函数式 updater 内调用（current 取队列最新值）。
   *  F20260825scrf：getShouldDefer 为真时（弹窗打开）暂存保留、跳过产出——背景冻结期
   *  流式更新零丢失、零渲染；解冻由调用方 flush() 或下个窗口自然恢复 */
  flush(): void {
    if (this.opts.getShouldDefer?.()) return
    if (this.pending.size === 0) return
    const updates = new Map<string, (current: LocalMessage[] | undefined) => LocalMessage[]>()
    for (const [convId, chain] of this.pending) {
      updates.set(convId, (current) => {
        const cur = current ?? []
        // 与 staging 基线同引用：窗口内无外部写入，直接应用暂存结果
        if (cur === chain.baseRef) return chain.staged
        // 外部已写入：重放 updater 链到最新列表（保留外部写入的效果）
        let list = cur
        for (const u of chain.updaters) list = u(list)
        return list
      })
    }
    this.pending.clear()
    this.opts.apply(updates)
  }

  /** 清理定时器与暂存（组件卸载时调用，防止泄漏与卸载后 setState） */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
  }
}
