/** HTML 卡片（html-card）纯函数库：meta 解析 / payload 校验 / 已回复集合派生 / 回执构造
 *  设计文档 F20260728htar §2/§3；与后端剥离函数、useCardBridge 共享同一套规则与测试向量。
 *  围栏扫描用 remark（mdast）解析：普通代码围栏是不透明块（内部的 reply 字样只是代码示例），
 *  支持 ~~~ 围栏与 blockquote/list 容器嵌套，与后端剥离函数同一解析语义 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Code, Nodes } from 'mdast'

/** 解析管线必须与渲染管线（react-markdown 挂 remarkGfm singleTilde:false）逐字节对齐：
 *  GFM 的 footnote definition 是容器块，裸 parse 与渲染对容器内围栏判定会分裂（R9） */
const parseMd = (body: string) =>
  unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).parse(body)

// Why: 转发共享常量（Issue #360 单一真相源在 @contract/api/html-card）——
// 保持从 lib/html-card 的既有导入路径不变，避免改动全部消费方
export { CARD_MAX_PER_MESSAGE, CARD_MAX_BYTES, CARD_SCHEMA_VERSION, CARD_MIN_HEIGHT, CARD_MAX_HEIGHT, CARD_PRESET_CLASSES_CSS } from '@contract/api/html-card'
/** 卡片提交 payload 限制 */
export const CARD_SUMMARY_MAX_CHARS = 500
export const CARD_DATA_MAX_BYTES = 2048

/** UTF-8 字节长度 */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** walk mdast 收集指定条件的 code 节点（容器内围栏同样覆盖；不透明块内部不会成为节点） */
function collectCodeNodes(body: string): Code[] {
  const codes: Code[] = []
  const visit = (node: Nodes) => {
    if (node.type === 'code') codes.push(node as Code)
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(parseMd(body))
  return codes
}

/** 从围栏 meta 提取属性值（title="..." / card="..."；遇到首个引号截断） */
function parseMetaAttr(meta: string | null | undefined, attr: string): string | null {
  if (!meta) return null
  const m = new RegExp(`(?:^|\\s)${attr}="([^"]*)"`).exec(meta)
  return m && m[1] ? m[1] : null
}

/** 解析围栏 meta（info string 原样透传）：提取 title="..." */
export function parseCardTitle(meta: string | null | undefined): string | null {
  return parseMetaAttr(meta, 'title')
}

/** F20261013csv3 T4：卡片重要性分级（`importance="high"` 默认展开）。
 *  只有两档：normal（默认，折叠）/ high（默认展开）；不是 `high` 一律按 normal
 *  （含缺失/解析失败——降级安全方向是折叠）。约束：high 不豁免单消息卡片预算
 *  （CARD_MAX_PER_MESSAGE），防止把 high 当预算旁路。 */
export type CardImportance = 'normal' | 'high'

/** 解析 importance 属性。缺省/非法值返回 'normal'（绝不抛错——meta 解析失败按 normal 处理） */
export function parseCardImportance(meta: string | null | undefined): CardImportance {
  const v = parseMetaAttr(meta, 'importance')
  return v === 'high' ? 'high' : 'normal'
}

/** 折叠态摘要行最大字符数（T3） */
export const CARD_FOLDED_SUMMARY_MAX_CHARS = 120

/** F20261013csv3 T3：从卡片 HTML 提取折叠态摘要行。
 *  口径（与既有卡面摘要互不依赖，纯展示层派生）：
 *  - 跳过 <script>/<style>/<textarea> 内容（脚本/样式不是给人看的）
 *  - 纯标点行视同空（装饰性分隔线等不产出信息）
 *  - 顺序取首个非空文本片段，截断至 CARD_FOLDED_SUMMARY_MAX_CHARS
 *  Why：旧折叠态只显示标题——「89% 发言纯文本」的宪法失稳现状下，卡片自身也须
 *  承担折叠态信息增量，否则折叠等于零信息。 */
export function extractFoldedSummary(html: string): string | null {
  // 1. 剥 script/style/textarea（含内容体，大小写不敏感）
  const stripped = html
    .replace(/<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|textarea)\b[^>]*\/>/gi, ' ')
  // 2. 剥全部标签，只留文本（块级标签换行保留行结构——行级判定依赖之；开+闭都换行）
  const text = stripped
    .replace(/<(div|p|h[1-6]|li|tr|td|th|section|article|header|footer|blockquote|ul|ol|table)\b[^>]*>/gi, '\n')
    .replace(/<\/(div|p|h[1-6]|li|tr|td|th|section|article|header|footer|blockquote|ul|ol|table)\b[^>]*>/gi, '\n')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  // 3. 行级扫描：首个「非空且非纯标点」的文本片段
  const PUNCT_ONLY = /^[\s—–_*=~·•◦▪▫│┃┊┈┉┄┅╌╍-]+$/
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  for (const line of lines) {
    if (PUNCT_ONLY.test(line)) continue // 纯标点视同空
    const collapsed = line.replace(/\s+/g, ' ').trim()
    if (collapsed.length === 0) continue
    return collapsed.length > CARD_FOLDED_SUMMARY_MAX_CHARS
      ? collapsed.slice(0, CARD_FOLDED_SUMMARY_MAX_CHARS - 1) + '…'
      : collapsed
  }
  return null
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

/** 扫描 user 消息列表，从 html-card-reply 围栏的 card="..." 提取已回复 cardId 集合。
 *  回执自带 cardId，零额外存储，跨刷新有效（前提：回执恒新于卡片，同在消息窗口内）。
 *  只扫 user 消息（回执只认搭档发的）；remark 解析保证普通围栏内的 reply 字样不算数 */
export function deriveRepliedCardIds(messages: Array<{ content: string; st: string }>): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.st !== 'user' || !m.content.includes('html-card-reply')) continue
    for (const code of collectCodeNodes(m.content)) {
      if (code.lang !== 'html-card-reply') continue
      const cardId = parseMetaAttr(code.meta, 'card')
      if (cardId) ids.add(cardId)
    }
  }
  return ids
}

/** body 中 html-card 围栏数量（fenceIndex 存在性判据：fenceIndex < 数量即围栏仍在）。
 *  挂起预览的自动丢弃用：用户收起卡片（iframe unmount）时围栏仍在，不丢预览。
 *  F20261009csp2 检视处置 2：活类围栏（html-card-play）计入——否则 useCardBridge 的
 *  cardFencePresent 对活类卡判假，submit 预览挂起即被瞬丢（游戏回传成绩闭环失效） */
export function countCardFences(body: string): number {
  if (!body.includes('html-card')) return 0
  return collectCodeNodes(body).filter(c => c.lang === 'html-card' || c.lang === 'html-card-play').length
}

/** 构造卡片回执 body：人类可读摘要 + html-card-reply JSON 围栏（cardId 关联，非 title） */
export function buildCardReplyBody(summary: string, cardId: string, data: unknown): string {
  const json = data === undefined ? '{}' : JSON.stringify(data)
  return `${summary}\n\n\`\`\`html-card-reply card="${cardId}"\n${json}\n\`\`\``
}
