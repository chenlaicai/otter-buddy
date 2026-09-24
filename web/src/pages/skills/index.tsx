import { useState, useEffect } from 'react'
import { Construction, Package } from 'lucide-react'

/**
 * #576（F20260901emps）：数据源 GET /api/skills（ResourceLoader 真相源）。
 * F20260924uxrc 改版：图鉴式分组卡阵——「左列表右详情」二分改为单栏网格，
 * 每张 skill 卡解析 frontmatter 三段式 description（施展/忌用/产出）分槽展示，
 * 趣味语言借海獭面板装备槽（emoji 门派徽章 / 槽位标签 / otter 选中态）。
 * 降级链不变：API 成功 → 真实清单；失败 → 内置兜底（带「离线兜底」标注）；空 → 显式空态。
 */
interface SkillEntry {
  name: string
  desc: string
}

// 内置兜底清单（API 不可达时的降级展示；正常环境下被真实数据取代）
const FALLBACK_SKILL_GROUPS: { label: string; skills: SkillEntry[] }[] = [
  {
    label: '默认搭档',
    skills: [
      { name: 'companion', desc: '不匹配任何其他 skill 时的兜底模式：自由协作对话' },
    ],
  },
  {
    label: '信息层',
    skills: [
      { name: 'core-workflow', desc: '信息查询与产出记录' },
      { name: 'troubleshooting', desc: '结构化排查：从症状到根因到修复' },
    ],
  },
  {
    label: '开发流程链',
    skills: [
      { name: 'requirement-analysis', desc: '模糊意图 → 结构化技术方案' },
      { name: 'code-implementation', desc: '已确认方案 → 代码 PR' },
      { name: 'adversarial-review', desc: '对代码变更或设计文档做对抗审视' },
      { name: 'worktree-isolation', desc: '修改 git 跟踪文件前的 worktree 隔离' },
      { name: 'post-merge-cleanup', desc: 'PR 合入后的 worktree/分支/issue 善后清理' },
    ],
  },
  {
    label: '编排层',
    skills: [
      { name: 'otter-summon', desc: '召唤小獭执行专项任务' },
    ],
  },
  {
    label: '元规范',
    skills: [
      { name: 'writing-skills', desc: '关于 skill 的 skill：铁律 + 契约 + 模板 + lint 规则' },
    ],
  },
]

/** 门派配置：分组 → 徽章 emoji + 归属描述。趣味锚点（海獭面板装备语言），色系收敛于 otter/stone */
const GROUP_SIGIL: Record<string, string> = {
  '默认搭档': '🍃',
  '信息层': '🔍',
  '开发流程链': '⚒️',
  '编排层': '🎪',
  '元规范': '📖',
  '其他': '📦',
}

export interface ParsedSkillDesc {
  when: string | null
  notFor: string | null
  output: string | null
  /** 未被三段式识别时的整段原文（兜底清单等非结构化文案走这里） */
  raw: string
}

/**
 * 解析 SKILL.md frontmatter 的三段式 description。
 * 标准格式（writing-skills 契约）：Use when: … Not for: … Output: …
 * 段间可能有 Precondition / co_loads 等其他行——三段正则各自锚定关键词，
 * 未识别的文案三段全 null（卡片降级为整段描述展示，不装模作样拆槽）。
 */
export function parseSkillDescription(desc: string): ParsedSkillDesc {
  const clean = desc.replace(/\s+/g, ' ').trim()
  const when = clean.match(/Use when:\s*(.*?)(?=\s(?:Not for:|Output:|Precondition:)|$)/i)?.[1]?.trim() || null
  const notFor = clean.match(/Not for:\s*(.*?)(?=\s(?:Output:|Precondition:|Use when:)|$)/i)?.[1]?.trim() || null
  const output = clean.match(/Output:\s*(.*?)(?=\s(?:Precondition:|Use when:|Not for:)|$)/i)?.[1]?.trim() || null
  return { when, notFor, output, raw: clean }
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; groups: { label: string; skills: SkillEntry[] }[]; degraded: boolean }
  | { kind: 'empty' }
  | { kind: 'error' }

/** 把 API 返回的平铺 skill 列表按内置分组顺序归类；未识别的归「其他」 */
function groupSkills(names: { name: string; desc: string }[]): { label: string; skills: SkillEntry[] }[] {
  const order = FALLBACK_SKILL_GROUPS.map(g => g.label)
  const buckets = new Map<string, SkillEntry[]>()
  for (const s of names) {
    const label = findGroupLabel(s.name) ?? '其他'
    if (!buckets.has(label)) buckets.set(label, [])
    buckets.get(label)!.push({ name: s.name, desc: s.desc })
  }
  // 按内置顺序输出，末尾追加未识别分组
  const result: { label: string; skills: SkillEntry[] }[] = []
  for (const label of order) {
    const skills = buckets.get(label)
    if (skills && skills.length > 0) result.push({ label, skills })
    buckets.delete(label)
  }
  for (const [label, skills] of buckets) result.push({ label, skills })
  return result
}

function findGroupLabel(skillName: string): string | null {
  for (const g of FALLBACK_SKILL_GROUPS) {
    if (g.skills.some(s => s.name === skillName)) return g.label
  }
  return null
}

/** 秘籍卡槽位行：文字标签 + 截断内容，展开后看全文 */
function SlotRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex gap-2 items-start">
      <span className={`text-[9px] font-semibold tracking-wider flex-shrink-0 w-7 pt-0.5 ${label === '忌用' ? 'text-rose-400' : 'text-stone-400'}`}>{label}</span>
      <p className="text-xs text-stone-600 leading-relaxed line-clamp-2">{text}</p>
    </div>
  )
}

export default function SkillsPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  /** 展开态：点卡 toggle，多卡可同时展开（图鉴翻阅感） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    fetch('/api/skills')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ skills: { name: string; description: string }[] }>
      })
      .then(data => {
        if (cancelled) return
        if (!data.skills || data.skills.length === 0) {
          setState({ kind: 'empty' })
          return
        }
        setState({
          kind: 'loaded',
          groups: groupSkills(data.skills.map(s => ({ name: s.name, desc: s.description }))),
          degraded: false,
        })
      })
      .catch(() => {
        if (cancelled) return
        setState({ kind: 'error' })
      })
    return () => { cancelled = true }
  }, [])

  // 降级：API 不可达时用内置清单（仍可展示，但标注非实时）
  const groups = state.kind === 'loaded' ? state.groups
    : state.kind === 'error' ? FALLBACK_SKILL_GROUPS
    : []
  const degraded = state.kind === 'error'
  const allSkills = groups.flatMap(g => g.skills)

  const toggle = (name: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-3 gap-3">
      {/* 馆藏总览：第一视觉锚点（动线起点），统计 + 只读声明整合于此，替代原 amber 警示条 */}
      <header className="glass rounded-3xl px-6 py-4 flex items-center gap-4 flex-shrink-0">
        <div className="w-11 h-11 rounded-2xl bg-otter-100 flex items-center justify-center text-xl flex-shrink-0">⛩️</div>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold text-stone-800">能力秘籍馆</h1>
          <p className="text-xs text-stone-500 mt-0.5">
            {allSkills.length} 门心法 · {groups.length} 大流派 · 族群共享，个体差异在武器与心法
          </p>
        </div>
        {degraded ? (
          <span className="text-[10px] px-2 py-1 rounded-full bg-amber-400/15 text-amber-600 flex-shrink-0" data-testid="degraded-badge">
            离线兜底清单，可能与实际不符
          </span>
        ) : (
          <span className="text-[10px] px-2 py-1 rounded-full bg-white/50 text-stone-400 flex items-center gap-1 flex-shrink-0">
            <Construction className="w-3 h-3" />
            只读展示 · 管理功能建设中
          </span>
        )}
      </header>

      {/* 加载中 / 空态 */}
      {state.kind === 'loading' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          <div className="w-6 h-6 border-2 border-otter-300 border-t-transparent rounded-full animate-spin" />
          <div className="text-sm text-stone-400">加载 skill 清单中...</div>
        </div>
      )}
      {state.kind === 'empty' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          <Package className="w-10 h-10 text-stone-300" />
          <div className="text-sm font-medium text-stone-400">未发现任何 skill</div>
          <div className="text-xs text-stone-400">
            .pi/skills 目录为空或未加载——请检查服务端 skill 加载日志
          </div>
        </div>
      )}

      {(state.kind === 'loaded' || state.kind === 'error') && (
        /* 分区卡阵：流派 banner + 自适应网格，一屏图鉴式扫读（替代左列表右详情二分） */
        <div className="flex flex-col gap-4">
          {groups.map(group => (
            <section key={group.label} aria-label={group.label}>
              {/* 流派 banner：徽章 + 派名 + 藏品数 */}
              <div className="flex items-center gap-2 mb-2 px-1">
                <span className="text-sm">{GROUP_SIGIL[group.label] ?? GROUP_SIGIL['其他']}</span>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-600">{group.label}</h2>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-skeleton text-stone-500">{group.skills.length} 门</span>
              </div>
              <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                {group.skills.map(s => {
                  const p = parseSkillDescription(s.desc)
                  const isOpen = expanded.has(s.name)
                  const structured = p.when || p.notFor || p.output
                  return (
                    <article
                      key={s.name}
                      onClick={() => toggle(s.name)}
                      aria-expanded={isOpen}
                      className={`glass-card rounded-2xl p-3.5 cursor-pointer transition hover:shadow-otter-lg hover:-translate-y-0.5 ${
                        isOpen ? 'ring-1 ring-otter-300' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="w-8 h-8 rounded-xl bg-white/70 flex items-center justify-center text-sm flex-shrink-0">
                            {GROUP_SIGIL[group.label] ?? GROUP_SIGIL['其他']}
                          </span>
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-stone-800 truncate">{s.name}</h3>
                            <span className="text-[9px] text-stone-400">{group.label}</span>
                          </div>
                        </div>
                        {structured && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-otter-400/15 text-otter-600 flex-shrink-0">
                            {isOpen ? '收起' : '秘籍'}
                          </span>
                        )}
                      </div>

                      {/* 三槽：施展 / 忌用 / 产出；非结构化文案整段展示 */}
                      <div className="mt-3 space-y-1.5">
                        {structured ? (
                          <>
                            {p.when && <SlotRow label="施展" text={p.when} />}
                            {p.notFor && <SlotRow label="忌用" text={p.notFor} />}
                            {p.output && <SlotRow label="产出" text={p.output} />}
                          </>
                        ) : (
                          <p className="text-xs text-stone-600 leading-relaxed line-clamp-2">{s.desc}</p>
                        )}
                      </div>

                      {/* 展开：秘籍全文（含 Precondition 等未分槽内容） */}
                      {isOpen && (
                        <pre className="mt-3 pt-2.5 border-t border-white/50 text-[11px] text-stone-500 whitespace-pre-wrap font-sans leading-relaxed">
                          {s.desc}
                        </pre>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
