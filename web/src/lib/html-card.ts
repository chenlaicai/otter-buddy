/** HTML 卡片（html-card）纯函数库：meta 解析 / payload 校验 / 已回复集合派生 / 回执构造
 *  设计文档 F20260728htar §2/§3；与后端剥离函数、useCardBridge 共享同一套规则与测试向量 */

/** 单消息卡片预算：第 3 张起前端降级为源码块 */
export const CARD_MAX_PER_MESSAGE = 2
/** 单卡体积预算（字节）：超出时折叠态加体积提示 */
export const CARD_MAX_BYTES = 4096
/** 卡片提交 payload 限制 */
export const CARD_SUMMARY_MAX_CHARS = 500
export const CARD_DATA_MAX_BYTES = 2048
/** 卡片 iframe 高度 clamp 区间 */
export const CARD_MIN_HEIGHT = 100
export const CARD_MAX_HEIGHT = 2000

/** UTF-8 字节长度 */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** 解析围栏 meta（info string 原样透传）：提取 title="..."；
 *  title 含引号时截断到首个引号（正则 [^"]* 的自然行为） */
export function parseCardTitle(meta: string | null | undefined): string | null {
  if (!meta) return null
  const m = /(?:^|\s)title="([^"]*)"/.exec(meta)
  if (!m || !m[1]) return null
  return m[1]
}

export interface CardPayloadValidation {
  ok: boolean
  error?: string
}

/** 校验卡片提交 payload（父页校验链的一环）：
 *  summary 非空 ≤500 字符；data 可选、JSON 序列化 ≤2KB、禁循环引用/函数 */
export function validateCardSubmitPayload(payload: unknown): CardPayloadValidation {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload 必须是对象' }
  }
  const { summary, data } = payload as { summary?: unknown; data?: unknown }
  if (typeof summary !== 'string' || summary.trim() === '') {
    return { ok: false, error: 'summary 不能为空' }
  }
  if (summary.length > CARD_SUMMARY_MAX_CHARS) {
    return { ok: false, error: `summary 超过 ${CARD_SUMMARY_MAX_CHARS} 字符` }
  }
  if (data !== undefined) {
    if (!isJsonSafe(data)) {
      return { ok: false, error: 'data 含循环引用或函数' }
    }
    if (byteLength(JSON.stringify(data)) > CARD_DATA_MAX_BYTES) {
      return { ok: false, error: `data 序列化超过 ${CARD_DATA_MAX_BYTES} 字节` }
    }
  }
  return { ok: true }
}

/** 递归检查 JSON 安全性：禁函数/symbol/undefined、禁循环引用。
 *  seen 按路径增删，共享引用（DAG）不算循环 */
function isJsonSafe(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(value as number)
  if (t !== 'object') return false // function / symbol / undefined / bigint
  if (seen.has(value)) return false
  seen.add(value)
  let safe: boolean
  if (Array.isArray(value)) {
    safe = value.every(v => isJsonSafe(v, seen))
  } else {
    const proto = Object.getPrototypeOf(value)
    // 只接受普通对象（类实例、Date、Map 等拒绝，避免序列化歧义）
    safe = (proto === Object.prototype || proto === null)
      && Object.values(value as Record<string, unknown>).every(v => isJsonSafe(v, seen))
  }
  seen.delete(value)
  return safe
}

/** 扫描消息列表，从 html-card-reply 围栏的 card="..." 提取已回复 cardId 集合。
 *  回执自带 cardId，零额外存储，跨刷新有效（前提：回执恒新于卡片，同在消息窗口内） */
export function deriveRepliedCardIds(messages: Array<{ content: string }>): Set<string> {
  const ids = new Set<string>()
  const fenceLine = /```+html-card-reply[^\n]*/g
  const cardAttr = /\bcard="([^"\n]*)"/
  for (const m of messages) {
    if (!m.content || !m.content.includes('html-card-reply')) continue
    for (const line of m.content.match(fenceLine) || []) {
      const c = cardAttr.exec(line)
      if (c && c[1]) ids.add(c[1])
    }
  }
  return ids
}

/** 构造卡片回执 body：人类可读摘要 + html-card-reply JSON 围栏（cardId 关联，非 title） */
export function buildCardReplyBody(summary: string, cardId: string, data: unknown): string {
  const json = data === undefined ? '{}' : JSON.stringify(data)
  return `${summary}\n\n\`\`\`html-card-reply card="${cardId}"\n${json}\n\`\`\``
}
