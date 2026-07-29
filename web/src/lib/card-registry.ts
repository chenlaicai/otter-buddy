/** iframe 卡片注册表（module 级）：contentWindow ↔ cardId 双向映射 + 卡片作者登记
 *  HtmlCard mount/unmount 时登记/清理；useCardBridge 用它做 source 白名单校验、
 *  resize 高度回写、回执作者路由。unmount 后到达的 postMessage 因 source 不在表内被丢弃 */

export interface CardEntry {
  cardId: string
  /** 卡片所在消息的 senderId（回执显式路由目标） */
  authorId: string
  contentWindow: Window
  /** resize 消息的高度回写（由 HtmlCard 提供） */
  setHeight?: (px: number) => void
}

const byWindow = new Map<Window, string>()
const byId = new Map<string, CardEntry>()

export function registerCard(entry: CardEntry): void {
  /** 同 cardId 重挂载（重展开）：清理旧 window 的反向映射——
   *  旧 iframe 已脱离 DOM，其 postMessage 不应再被认领（source 白名单只含存活 iframe） */
  const prev = byId.get(entry.cardId)
  if (prev && prev.contentWindow !== entry.contentWindow) byWindow.delete(prev.contentWindow)
  byWindow.set(entry.contentWindow, entry.cardId)
  byId.set(entry.cardId, entry)
}

/** 仅当 window 与登记一致时才清理（同 cardId 重挂载的新 iframe 不被旧 cleanup 误删） */
export function unregisterCard(cardId: string, contentWindow: Window): void {
  const entry = byId.get(cardId)
  if (!entry || entry.contentWindow !== contentWindow) return
  byId.delete(cardId)
  byWindow.delete(contentWindow)
}

export function getCardIdByWindow(win: Window): string | undefined {
  return byWindow.get(win)
}

export function getCardEntry(cardId: string): CardEntry | undefined {
  return byId.get(cardId)
}
