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

/** 卡片是否仍在 DOM 中（挂起预览的自动丢弃判据） */
export function hasCard(cardId: string): boolean {
  return byId.has(cardId)
}
