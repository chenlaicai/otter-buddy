import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Construction, Package } from 'lucide-react'
import '../../styles/globals.css'
import { AppLayout } from '../../components/AppLayout'

// TODO: API contract not yet defined - Skill 管理功能建设中（issue #366 PR-1），
// 当前为只读展示。数据为静态拷贝，真相源：prompts/skills/manifest.yaml（+ 各 SKILL.md）
interface SkillEntry {
  name: string
  desc: string
}

// 分层结构对应 manifest.yaml 中的注释分组
const skillGroups: { label: string; skills: SkillEntry[] }[] = [
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

const allSkills = skillGroups.flatMap(g => g.skills)

function SkillsPage() {
  const [selectedName, setSelectedName] = useState(allSkills[0]?.name || '')
  const selectedSkill = allSkills.find(s => s.name === selectedName)

  return (
    <AppLayout activeView="skills">
      <div className="flex flex-col flex-1 overflow-hidden p-3 gap-3">
        {/* Under-construction notice */}
        <div className="flex items-start gap-2.5 px-5 py-3 glass rounded-2xl border border-amber-300/40 bg-amber-400/10">
          <Construction className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="text-xs leading-relaxed text-stone-600">
            <span className="font-semibold text-amber-600">建设中</span>
            Skill 目录为只读展示，数据来自系统真实 skill 清单；注册、加载、卸载等管理功能尚未接入，暂不可用。
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden gap-3">
          {/* Skill List Panel */}
          <aside className="w-56 glass rounded-3xl flex flex-col flex-shrink-0 overflow-y-auto">
            <div className="p-3 border-b border-white/40">
              <span className="text-sm font-semibold text-stone-700">能力库</span>
            </div>

            {skillGroups.map(group => (
              <div key={group.label}>
                <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                  {group.label}
                </div>
                {group.skills.map(s => (
                  <div
                    key={s.name}
                    onClick={() => setSelectedName(s.name)}
                    className={`px-3 py-2 mx-2 rounded-xl cursor-pointer transition ${
                      s.name === selectedName ? 'conv-active' : 'hover:bg-white/30'
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
      </div>
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<SkillsPage />)
