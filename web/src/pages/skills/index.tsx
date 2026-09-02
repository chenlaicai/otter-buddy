import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Construction, Package } from 'lucide-react'
import '../../styles/globals.css'
import { AppLayout } from '../../components/AppLayout'

/**
 * #576（F20260901emps）：数据源从静态快照改为 GET /api/skills（ResourceLoader 真相源）。
 * Why: 此前硬编码 9 个 skill（8/21 快照），仓库演化到 11 个后页面过时且不会更新。
 * 降级链：API 成功 → 真实清单；API 失败 → 内置兜底清单（带「离线兜底」标注）；
 * API 成功但空 → 显式空态文案（不再静默空白）。
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
      { name: 'stock-analysis', desc: 'A股/港股结构化分析与纸面交易' },
    ],
  },
]

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

export function SkillsPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

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
  const [selectedName, setSelectedName] = useState(allSkills[0]?.name || '')
  // useState 初始值在 loading 态（allSkills 空）求值为 ''，API 加载后不会重求——
  // 无点击时详情面板空白（#689 审视建议 1）。回退语义：当前选择失效时自动选中首项，用户已点击的选择保留。
  const selectedSkill = allSkills.find(s => s.name === selectedName) ?? allSkills[0]

  return (
    <AppLayout activeView="skills">
      <div className="flex flex-col flex-1 overflow-hidden p-3 gap-3">
        {/* Under-construction notice */}
        <div className="flex items-start gap-2.5 px-5 py-3 glass rounded-2xl border border-amber-300/40 bg-amber-400/10">
          <Construction className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="text-xs leading-relaxed text-stone-600">
            <span className="font-semibold text-amber-600">建设中</span>
            Skill 目录为只读展示，数据来自系统真实 skill 清单；注册、加载、卸载等管理功能尚未接入，暂不可用。
            {degraded && (
              <span className="block mt-1 text-amber-600">
                （服务连接失败，当前展示内置离线清单，可能与实际不符）
              </span>
            )}
          </div>
        </div>

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
          <div className="flex flex-1 overflow-hidden gap-3">
            {/* Skill List Panel */}
            <aside className="w-56 glass rounded-3xl flex flex-col flex-shrink-0 overflow-y-auto">
              <div className="p-3 border-b border-white/40">
                <span className="text-sm font-semibold text-stone-700">能力库</span>
              </div>

              {groups.map(group => (
                <div key={group.label}>
                  <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                    {group.label}
                  </div>
                  {group.skills.map(s => (
                    <div
                      key={s.name}
                      onClick={() => setSelectedName(s.name)}
                      className={`px-3 py-2 mx-2 rounded-xl cursor-pointer transition ${
                        s.name === selectedSkill?.name ? 'conv-active' : 'hover:bg-white/30'
                      }`}
                    >
                      <div className="text-xs font-medium text-stone-700">{s.name}</div>
                      <div className="text-[10px] text-stone-400">{s.desc}</div>
                    </div>
                  ))}
                </div>
              ))}
            </aside>

            {/* Skill Detail */}
            <main className="flex-1 glass rounded-3xl overflow-y-auto p-6">
              {!selectedSkill ? (
                <div className="flex flex-col items-center justify-center h-full gap-2">
                  <Package className="w-10 h-10 text-stone-300" />
                  <div className="text-sm font-medium text-stone-400">未选择 Skill</div>
                </div>
              ) : (
                <div className="max-w-[700px] mx-auto">
                  <div className="flex items-center gap-3 mb-4">
                    <h2 className="text-lg font-semibold text-stone-700">{selectedSkill.name}</h2>
                  </div>

                  <div className="mb-4">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1">描述</div>
                    <div className="text-sm text-stone-600">{selectedSkill.desc}</div>
                  </div>
                </div>
              )}
            </main>
          </div>
        )}
      </div>
    </AppLayout>
  )
}

/** 入口挂载（测试经 export 的 SkillsPage 直接渲染，不走此副作用） */
const root = createRoot(document.getElementById('root')!)
root.render(<SkillsPage />)
