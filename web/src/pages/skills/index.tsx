import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Construction, Package } from 'lucide-react'
import '../../styles/globals.css'

import { skills, getAllOtters } from '../../mock/data'
import { AppLayout } from '../../components/AppLayout'

// TODO: API contract not yet defined - 当前为只读示意数据，Skill 管理功能建设中（issue #366 PR-1）

const typeLabels: Record<string, string> = {
  tool: '工具 (tool)',
  workflow: '工作流 (workflow)',
  prompt_template: '提示模板 (prompt_template)',
}

function SkillsPage() {
  const [selectedId, setSelectedId] = useState(skills[0]?.id || '')

  const otters = getAllOtters()
  const selectedSkill = skills.find(s => s.id === selectedId)

  const groups = {
    tool: skills.filter(s => s.type === 'tool'),
    workflow: skills.filter(s => s.type === 'workflow'),
    prompt_template: skills.filter(s => s.type === 'prompt_template'),
  }

  const assignedOtters = selectedSkill?.assignedTo.map(id => otters.find(o => o.id === id)).filter(Boolean) || []

  return (
    <AppLayout activeView="skills">
      <div className="flex flex-1 overflow-hidden p-3 gap-3">
        {/* Skill List Panel */}
        <aside className="w-56 glass rounded-3xl flex flex-col flex-shrink-0 overflow-y-auto">
          <div className="p-3 border-b border-white/40">
            <span className="text-sm font-semibold text-stone-700">能力库</span>
          </div>

          {(['tool', 'workflow', 'prompt_template'] as const).map(type => (
            <div key={type}>
              <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
                {typeLabels[type]}
              </div>
              {groups[type].length === 0 ? (
                <div className="px-3 pb-1 text-xs text-stone-400">无</div>
              ) : (
                groups[type].map(s => (
                  <div
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={`px-3 py-2 mx-2 rounded-xl cursor-pointer transition ${
                      s.id === selectedId ? 'conv-active' : 'hover:bg-white/30'
                    }`}
                  >
                    <div className="text-xs font-medium text-stone-700">{s.name}</div>
                    <div className="text-[10px] text-stone-400">{s.desc}</div>
                  </div>
                ))
              )}
            </div>
          ))}
        </aside>

        {/* Skill Detail */}
        <main className="flex-1 flex flex-col glass rounded-3xl overflow-hidden">
          {/* Under-construction notice */}
          <div className="flex items-start gap-2.5 px-5 py-3 border-b border-white/40 bg-amber-400/10">
            <Construction className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="text-xs leading-relaxed text-stone-600">
              <span className="font-semibold text-amber-600">建设中</span>
              Skill 管理功能尚未接入真实系统，当前展示的是示意数据；注册、加载、卸载等管理操作暂不可用。
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {!selectedSkill ? (
              <div className="flex flex-col items-center justify-center h-full gap-2">
                <Package className="w-10 h-10 text-stone-300" />
                <div className="text-sm font-medium text-stone-400">暂无 Skill</div>
              </div>
            ) : (
              <div className="max-w-[700px] mx-auto">
                <div className="flex items-center gap-3 mb-4">
                  <h2 className="text-lg font-semibold text-stone-700">{selectedSkill.name}</h2>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-otter-400/15 text-otter-500">
                    {selectedSkill.type}
                  </span>
                </div>

                <div className="mb-4">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1">描述</div>
                  <div className="text-sm text-stone-600">{selectedSkill.desc}</div>
                </div>

                <div className="mb-4">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1">定义 (Schema + Handler)</div>
                  <pre className="glass-card rounded-xl p-3 text-xs font-mono text-stone-600 overflow-x-auto"><code>{`{
  "schema": { "type": "object", "properties": { "input": { "type": "string" } } },
  "handlerRef": "handlers/${selectedSkill.name}"
}`}</code></pre>
                </div>

                <div className="mb-4">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">已分配 Otter</div>
                  <div className="flex gap-1.5 flex-wrap">
                    {assignedOtters.length ? assignedOtters.map(o => (
                      <span
                        key={o!.id}
                        className="text-xs font-medium px-2.5 py-1 rounded-full bg-white/40 text-stone-600"
                      >
                        {o!.name}
                      </span>
                    )) : <span className="text-xs text-stone-400">未分配</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<SkillsPage />)
