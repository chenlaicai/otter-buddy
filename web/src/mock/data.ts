/** Mock data for UI development - TODO: API contract not yet defined */

export interface Otter {
  id: string
  name: string
  type: 'big' | 'small'
  createdAt: string
  role?: { name: string; resp: string[] }
  parentOtterId?: string
  ci?: number
}

export interface OtterSession {
  id: string
  otterId: string
  status: 'active' | 'archived'
  startedAt: string
  archivedAt: string | null
  archiveReason: string | null
  isNegativeCase: boolean
  summary: string | null
}

export interface Conversation {
  id: string
  title: string
  status: 'active' | 'completed' | 'archived'
  parentId: string | null
  otterIds: string[]
}

export interface Message {
  id: string
  st: 'user' | 'otter'
  si: string
  content: string
  ts: string
  dur: string | null
  sp?: string
  ctx: number
  ctxMax: number
}

export interface KeyFact {
  id: string
  content: string
  category: string
  flagged: boolean
}

export interface LinkedResource {
  id: string
  type: string
  url: string
  title: string
  auto: boolean
}

export interface Skill {
  id: string
  name: string
  desc: string
  type: 'tool' | 'workflow' | 'prompt_template'
  assignedTo: string[]
}

export interface MemoryEntry {
  id: string
  content: string
  contentType: 'message' | 'conversation_summary' | 'key_fact' | 'linked_resource'
  layer: 'working' | 'historical' | 'key_info'
  conversationTitle: string
  time: string
  score: string
  userFlagged: boolean
}

export const bigOtter: Otter = {
  id: 'o1',
  name: '大獭',
  type: 'big',
  createdAt: '2026-07-01',
}

export const smallOtters: Otter[] = [
  { id: 'o2', name: '分析獭', type: 'small', createdAt: '2026-07-01', role: { name: '方案A视角', resp: ['从用户体验角度分析', '关注易用性'] }, parentOtterId: 'o1', ci: 1 },
  { id: 'o3', name: '测试獭', type: 'small', createdAt: '2026-07-01', role: { name: '方案B视角', resp: ['从技术架构角度分析', '关注可维护性'] }, parentOtterId: 'o1', ci: 2 },
]

export const otterSessions: Record<string, OtterSession[]> = {
  o1: [
    { id: 's1a', otterId: 'o1', status: 'active', startedAt: '2026-07-13 08:00', archivedAt: null, archiveReason: null, isNegativeCase: false, summary: null },
    { id: 's1b', otterId: 'o1', status: 'archived', startedAt: '2026-07-12 08:00', archivedAt: '2026-07-13 08:00', archiveReason: 'restart', isNegativeCase: true, summary: '之前方向偏差较大' },
  ],
  o2: [
    { id: 's2a', otterId: 'o2', status: 'active', startedAt: '2026-07-13 09:30', archivedAt: null, archiveReason: null, isNegativeCase: false, summary: null },
  ],
  o3: [
    { id: 's3a', otterId: 'o3', status: 'active', startedAt: '2026-07-13 10:00', archivedAt: null, archiveReason: null, isNegativeCase: false, summary: null },
  ],
}

export const conversations: Conversation[] = [
  { id: 'c1', title: 'UI 设计讨论', status: 'active', parentId: null, otterIds: ['o1', 'o2', 'o3'] },
  { id: 'c2', title: '数据库选型', status: 'active', parentId: 'c1', otterIds: ['o1'] },
  { id: 'c3', title: '前端框架对比', status: 'completed', parentId: null, otterIds: ['o1'] },
  { id: 'c4', title: 'API 设计规范', status: 'archived', parentId: null, otterIds: ['o1'] },
  { id: 'c5', title: '测试策略', status: 'active', parentId: 'c1', otterIds: ['o1'] },
]

export const messages: Record<string, Message[]> = {
  c1: [
    { id: 'm1', st: 'user', si: 'user', content: '我们来做 UI 设计吧', ts: '2026-07-13 09:00:12', dur: null, ctx: 120, ctxMax: 128000 },
    { id: 'm2', st: 'otter', si: 'o1', sp: '> 检索记忆: "UI 设计"\n> 找到 3 条相关记忆\n> 分析 S1-S4 设计文档\n> 生成回复中...', content: '好的！我来分析一下现有的设计文档。\n\n基于 **S1-S4** 的设计，我们需要：\n\n1. 对话视图（三栏布局）\n2. 记忆搜索视图\n3. 能力库视图\n4. 设置视图\n\n```typescript\ninterface ChatView {\n  conversationId: string;\n  messages: Message[];\n}\n```\n\n你觉得这个方向如何？', ts: '2026-07-13 09:00:15', dur: '2.3s', ctx: 380, ctxMax: 128000 },
    { id: 'm3', st: 'user', si: 'user', content: '方向没问题，先出 UI 清单', ts: '2026-07-13 09:02:30', dur: null, ctx: 420, ctxMax: 128000 },
    { id: 'm4', st: 'otter', si: 'o1', sp: '> 整理 UI 清单\n> 4 页面 + 10 弹窗 + 15 状态\n> 完成', content: '已经整理好了 UI 清单，包含 **4 个页面**、**10 个弹窗** 和 **15 种状态**。覆盖全部 8 个用例。', ts: '2026-07-13 09:03:08', dur: '1.8s', ctx: 520, ctxMax: 128000 },
    { id: 'm5', st: 'otter', si: 'o2', sp: '> 从用户体验角度分析\n> 检查信息密度', content: '从用户体验角度，我建议三栏布局要注重信息密度控制，右栏不能太拥挤。', ts: '2026-07-13 09:05:22', dur: '3.1s', ctx: 680, ctxMax: 128000 },
    { id: 'm6', st: 'otter', si: 'o3', sp: '> 从技术架构角度分析\n> 评估 SSE vs WebSocket', content: '从技术架构角度，建议用 SSE 流式推送，前端用 EventSource 接收。', ts: '2026-07-13 09:06:10', dur: '2.7s', ctx: 820, ctxMax: 128000 },
  ],
  c2: [
    { id: 'm7', st: 'user', si: 'user', content: '数据库选型用什么？', ts: '2026-07-13 10:00:00', dur: null, ctx: 50, ctxMax: 128000 },
    { id: 'm8', st: 'otter', si: 'o1', sp: '> 检索记忆: "数据库"', content: '使用 **SQLite** + FTS5 + sqlite-vec。', ts: '2026-07-13 10:00:03', dur: '1.2s', ctx: 120, ctxMax: 128000 },
  ],
  c3: [
    { id: 'm9', st: 'user', si: 'user', content: '前端用什么框架？', ts: '2026-07-13 11:00:00', dur: null, ctx: 50, ctxMax: 128000 },
    { id: 'm10', st: 'otter', si: 'o1', sp: '> 检索技术栈信息', content: 'React 19 + Tailwind 4 + Hono', ts: '2026-07-13 11:00:02', dur: '0.9s', ctx: 90, ctxMax: 128000 },
  ],
}

export const keyFacts: Record<string, KeyFact[]> = {
  c1: [
    { id: 'kf1', content: 'UI 采用三栏布局', category: '决策', flagged: true },
    { id: 'kf2', content: '消息格式为基础 Markdown', category: '决策', flagged: false },
  ],
  c2: [
    { id: 'kf3', content: '使用 SQLite + FTS5 + sqlite-vec', category: '技术选型', flagged: false },
  ],
}

export const linkedResources: Record<string, LinkedResource[]> = {
  c1: [
    { id: 'lr1', type: 'pr', url: 'https://github.com/chenlaicai/otter-buddy/pull/6', title: 'S1 产品形态定义 PR', auto: false },
    { id: 'lr2', type: 'file', url: 'docs/features/2026/07/09/F20260709x7k3.md', title: 'S1 Feature 文档', auto: true },
  ],
  c2: [
    { id: 'lr3', type: 'url', url: 'https://www.sqlite.org/fts5.html', title: 'SQLite FTS5 文档', auto: false },
  ],
}

export const skills: Skill[] = [
  { id: 'sk1', name: 'code-review', desc: '代码审查能力', type: 'tool', assignedTo: ['o2'] },
  { id: 'sk2', name: 'deep-research', desc: '深度研究能力', type: 'workflow', assignedTo: [] },
  { id: 'sk3', name: 'summary-template', desc: '摘要模板', type: 'prompt_template', assignedTo: ['o3'] },
]

export const memoryEntries: MemoryEntry[] = [
  { id: 'me1', content: 'UI 采用三栏布局，左栏对话列表，中央消息流，右栏上下文面板', contentType: 'key_fact', layer: 'key_info', conversationTitle: 'UI 设计讨论', time: '2026-07-13 09:03', score: '0.92', userFlagged: true },
  { id: 'me2', content: '基于 S1-S4 设计文档，需要 4 个页面：对话、记忆搜索、能力库、设置', contentType: 'message', layer: 'historical', conversationTitle: 'UI 设计讨论', time: '2026-07-13 09:00', score: '0.88', userFlagged: false },
  { id: 'me3', content: '数据库选型决定使用 SQLite + FTS5 + sqlite-vec', contentType: 'key_fact', layer: 'key_info', conversationTitle: '数据库选型', time: '2026-07-13 10:00', score: '0.85', userFlagged: false },
  { id: 'me4', content: '前端框架确定为 React 19 + Tailwind 4 + Hono', contentType: 'message', layer: 'historical', conversationTitle: '前端框架对比', time: '2026-07-13 11:00', score: '0.79', userFlagged: false },
  { id: 'me5', content: '消息格式采用基础 Markdown 渲染，支持代码块、加粗、列表', contentType: 'key_fact', layer: 'key_info', conversationTitle: 'UI 设计讨论', time: '2026-07-13 09:03', score: '0.75', userFlagged: false },
]

/** Otter color system */
export const otterColors: Record<string, { hex: string; gradient: string; nameClass: string; border: string }> = {
  o1: { hex: '#8B6F47', gradient: 'linear-gradient(135deg,#A88260,#6B5638)', nameClass: 'text-otter-500', border: '#8B6F47' },
  o2: { hex: '#4A9B9B', gradient: 'linear-gradient(135deg,#7BC5C5,#3A8B8B)', nameClass: 'text-teal-500', border: '#4A9B9B' },
  o3: { hex: '#D9A57B', gradient: 'linear-gradient(135deg,#E8B98E,#C9956B)', nameClass: 'text-caramel-500', border: '#D9A57B' },
  o4: { hex: '#9B8AC8', gradient: 'linear-gradient(135deg,#B5A8D8,#8B7AB8)', nameClass: 'text-lavender-500', border: '#9B8AC8' },
  o5: { hex: '#C9956B', gradient: 'linear-gradient(135deg,#E8B98E,#C9956B)', nameClass: 'text-caramel-500', border: '#C9956B' },
}

export function getOtterColor(otterId: string, ci?: number) {
  if (otterColors[otterId]) return otterColors[otterId]
  if (ci && ci >= 1 && ci <= 4) return otterColors[`o${ci + 1}`]
  return otterColors.o1
}

export function getOtter(id: string): Otter | undefined {
  if (id === 'o1') return bigOtter
  return smallOtters.find(o => o.id === id)
}

export function getAllOtters(): Otter[] {
  return [bigOtter, ...smallOtters]
}
