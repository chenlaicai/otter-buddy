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
 * 新语义：update() 调用时**立即**对暂存副本（pending 或外部提供的 base）执行 updater
 * （调用方可依赖闭包标志位模式，如 added 计数）；窗口到期 flush 一次性 apply。
 *
 * F20260814qswp 二轮（对抗审视修复）：首版"暂存副本 + pending 优先"引入了新回归——
 * 窗口内若有**不走本 batcher 的直接 setState 写入**（轮询合并 / 上翻加载 prepend /
 * 乐观 abort / tmp 追加），后续 update 仍基于窗口前的旧暂存，flush 时整体覆盖，
 * 直接写入被抹掉（流式期间上翻加载历史会稳定复现历史消失）。旧实现反而不丢：
 * 其 updater 在 React 更新队列中按序执行，读到的是含直接写入的最新 state。
 *
 * 修复：staging 开始时记录 base 引用快照；flush 时若 getBase 返回的引用已变化
 * （外部写入过），把**暂存的 updater 链重放**到当前最新列表上——等价于旧实现的
 * "延迟到队列处理时对最新 state 执行"。引用未变则直接应用暂存结果（省一次重放）。
 * 要求 updater 是纯函数（list → list，无闭包外副作用）——现有全部调用点满足。
 */
export interface MessageBatcherOptions {
  /** 合并窗口毫秒数 */
  windowMs: number
  /** 读取某会话当前消息列表（真实 state 的同步镜像，如 ref；无会话记录时返回空数组） */
  getBase: (convId: string) => LocalMessage[]
  /** 窗口到期：将暂存的会话 → 列表映射应用到真实 state */
  apply: (updates: ReadonlyMap<string, LocalMessage[]>) => void
}

interface PendingChain {
  /** staging 开始时 getBase 返回的引用（undefined 表示当时无会话记录） */
  baseRef: LocalMessage[] | undefined
  /** 按序暂存的 updater 链（flush 重放用） */
  updaters: Array<(prev: LocalMessage[]) => LocalMessage[]>
  /** 对暂存副本链式执行的结果（base 未变时直接应用） */
  staged: LocalMessage[]
}

export class MessageBatcher {
  private pending = new Map<string, PendingChain>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: MessageBatcherOptions) {}

  /** 对暂存副本同步执行 updater；有实际变更时暂存并启动合并窗口 */
  update(convId: string, updater: (prev: LocalMessage[]) => LocalMessage[]): void {
    let chain = this.pending.get(convId)
    if (!chain) {
      const base = this.opts.getBase(convId)
      chain = { baseRef: base, updaters: [], staged: base }
      this.pending.set(convId, chain)
    }
    const updated = updater(chain.staged)
    if (updated === chain.staged) return
    chain.staged = updated
    chain.updaters.push(updater)
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.opts.windowMs)
    }
  }

  /** 立即应用全部暂存更新（窗口到期或需要立即提交时调用） */
  flush(): void {
    if (this.pending.size === 0) return
    const updates = new Map<string, LocalMessage[]>()
    for (const [convId, chain] of this.pending) {
      const current = this.opts.getBase(convId)
      if (current === chain.baseRef) {
        // 窗口内无外部写入：直接应用暂存结果
        updates.set(convId, chain.staged)
      } else {
        // 外部已写入：重放 updater 链到最新列表（恢复旧实现的"对最新 state 执行"语义）
        let list = current
        for (const u of chain.updaters) list = u(list)
        updates.set(convId, list)
      }
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
