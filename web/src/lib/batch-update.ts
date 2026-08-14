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
 * 新语义：update() 调用时**立即**对暂存副本（pending 或外部提供的 base）执行 updater，
 * 窗口内多次 update 链式生效；窗口到期 flush 一次性 apply 到真实 state。
 * 调用方仍可依赖“updater 同步执行”（闭包标志位模式，如 added 计数）。
 *
 * 窗口内的暂存值与外部对 state 的直接写入（如轮询快照）仍是 Map-overwrite
 * 语义——依赖 upsertTerminalMessage 等幂等合并兜底，与旧实现一致。
 */
export interface MessageBatcherOptions {
  /** 合并窗口毫秒数 */
  windowMs: number
  /** 读取某会话当前消息列表（真实 state 的同步镜像，如 ref；无会话记录时返回空数组） */
  getBase: (convId: string) => LocalMessage[]
  /** 窗口到期：将暂存的会话 → 列表映射应用到真实 state */
  apply: (updates: ReadonlyMap<string, LocalMessage[]>) => void
}

export class MessageBatcher {
  private pending = new Map<string, LocalMessage[]>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: MessageBatcherOptions) {}

  /** 对暂存副本同步执行 updater；有实际变更时暂存并启动合并窗口 */
  update(convId: string, updater: (prev: LocalMessage[]) => LocalMessage[]): void {
    const base = this.pending.get(convId) ?? this.opts.getBase(convId)
    const updated = updater(base)
    if (updated === base) return
    this.pending.set(convId, updated)
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.opts.windowMs)
    }
  }

  /** 立即应用全部暂存更新（窗口到期或组件卸载前调用） */
  flush(): void {
    if (this.pending.size === 0) return
    const updates = new Map(this.pending)
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
