import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Package } from 'lucide-react'
import '../../styles/globals.css'

import type { Skill } from '../../mock/data'
import { skills as initialSkills, getAllOtters } from '../../mock/data'
import { AppLayout } from '../../components/AppLayout'
import { Modal, ModalButton } from '../../components/Modal'
import { showToast } from '../../components/Toast'

// TODO: API contract not yet defined - all data is mocked

function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>(initialSkills)
  const [selectedId, setSelectedId] = useState(initialSkills[0]?.id || '')
  const [showRegister, setShowRegister] = useState(false)
  const [showLoad, setShowLoad] = useState(false)

  // Register form state
  const [regName, setRegName] = useState('')
  const [regDesc, setRegDesc] = useState('')
  const [regType, setRegType] = useState<'tool' | 'prompt_template' | 'workflow'>('tool')
  const [regSchema, setRegSchema] = useState('{\n  "type": "object",\n  "properties": {\n    "input": { "type": "string" }\n  }\n}')
  const [regHandler, setRegHandler] = useState('')

  // Load form state
  const [loadOtter, setLoadOtter] = useState('o1')

  const otters = getAllOtters()
  const selectedSkill = skills.find(s => s.id === selectedId)

  const groups = {
    tool: skills.filter(s => s.type === 'tool'),
    workflow: skills.filter(s => s.type === 'workflow'),
    prompt_template: skills.filter(s => s.type === 'prompt_template'),
  }

  const typeLabels: Record<string, string> = {
    tool: '工具 (tool)',
    workflow: '工作流 (workflow)',
    prompt_template: '提示模板 (prompt_template)',
  }

  function registerSkill() {
    if (!regName.trim()) {
      showToast('请输入名称', 'error')
      return
    }
    const newSkill: Skill = {
      id: 'skill-' + Date.now(),
      name: regName,
      desc: regDesc,
      type: regType,
      assignedTo: [],
    }
    setSkills(prev => [...prev, newSkill])
    setShowRegister(false)
    setRegName(''); setRegDesc(''); setRegHandler('')
    showToast('Skill 已注册', 'success')
  }

  function loadSkillToOtter() {
    setSkills(prev => prev.map(s => {
      if (s.id === selectedId && !s.assignedTo.includes(loadOtter)) {
        return { ...s, assignedTo: [...s.assignedTo, loadOtter] }
      }
      return s
    }))
    setShowLoad(false)
    showToast('Skill 已加载', 'success')
  }

  function unloadSkill(id: string) {
    setSkills(prev => prev.map(s => s.id === id ? { ...s, assignedTo: [] } : s))
    showToast('Skill 已从所有 Otter 卸载', 'success')
  }

  const assignedOtters = selectedSkill?.assignedTo.map(id => otters.find(o => o.id === id)).filter(Boolean) || []

  return (
    <AppLayout activeView="skills">
      <div className="flex flex-1 overflow-hidden p-3 gap-3">
        {/* Skill List Panel */}
        <aside className="w-56 glass rounded-3xl flex flex-col flex-shrink-0 overflow-y-auto">
          <div className="p-3 flex justify-between items-center border-b border-white/40">
            <span className="text-sm font-semibold text-stone-700">能力库</span>
            <button
              onClick={() => setShowRegister(true)}
              className="px-2.5 py-1 text-xs text-white rounded-lg shadow-glow transition"
              style={{ background: 'linear-gradient(135deg,#A88260,#6B5638)' }}
            >
              + 注册
            </button>
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
                      s.id === selectedId ? 'glass-card shadow-bubble' : 'hover:bg-white/30'
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
        <main className="flex-1 glass rounded-3xl overflow-y-auto p-6">
          {!selectedSkill ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Package className="w-10 h-10 text-stone-300" />
              <div className="text-sm font-medium text-stone-400">尚未注册任何 Skill</div>
              <div className="text-xs text-stone-400">点击上方按钮注册</div>
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
                    <span key={o!.id} className="text-xs font-medium px-2.5 py-1 rounded-full bg-white/40 text-stone-600">
                      {o!.name}
                    </span>
                  )) : <span className="text-xs text-stone-400">未分配</span>}
                </div>
              </div>

              <div className="flex gap-2 mt-6">
                <button
                  onClick={() => setShowLoad(true)}
                  className="px-4 py-2 text-sm text-white rounded-xl shadow-glow transition"
                  style={{ background: 'linear-gradient(135deg,#A88260,#6B5638)' }}
                >
                  加载到 Otter
                </button>
                <button
                  onClick={() => unloadSkill(selectedSkill.id)}
                  className="px-4 py-2 text-sm glass-card text-stone-600 rounded-xl hover:bg-white/50 transition"
                >
                  从所有 Otter 卸载
                </button>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Register Skill Modal */}
      <Modal
        isOpen={showRegister}
        onClose={() => setShowRegister(false)}
        title="注册 Skill"
        width="560px"
        footer={
          <>
            <ModalButton onClick={() => setShowRegister(false)}>取消</ModalButton>
            <ModalButton variant="primary" onClick={registerSkill}>注册</ModalButton>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">名称 (唯一)</label>
            <input value={regName} onChange={e => setRegName(e.target.value)} className="form-input w-full" placeholder="如: code-review" />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">描述</label>
            <input value={regDesc} onChange={e => setRegDesc(e.target.value)} className="form-input w-full" placeholder="Skill 描述" />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">类型</label>
            <select value={regType} onChange={e => setRegType(e.target.value as typeof regType)} className="form-input w-full">
              <option value="tool">工具</option>
              <option value="prompt_template">提示模板</option>
              <option value="workflow">工作流</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">Schema (JSON)</label>
            <textarea value={regSchema} onChange={e => setRegSchema(e.target.value)} className="form-input w-full font-mono min-h-[80px] resize-none text-xs" />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1.5">Handler 引用</label>
            <input value={regHandler} onChange={e => setRegHandler(e.target.value)} className="form-input w-full" placeholder="handlerRef" />
          </div>
        </div>
      </Modal>

      {/* Load Skill to Otter Modal */}
      <Modal
        isOpen={showLoad}
        onClose={() => setShowLoad(false)}
        title="加载 Skill 到 Otter"
        width="400px"
        footer={
          <>
            <ModalButton onClick={() => setShowLoad(false)}>取消</ModalButton>
            <ModalButton variant="primary" onClick={loadSkillToOtter}>加载</ModalButton>
          </>
        }
      >
        <label className="block text-xs font-medium text-stone-500 mb-1.5">选择 Otter</label>
        <select value={loadOtter} onChange={e => setLoadOtter(e.target.value)} className="form-input w-full">
          {otters.map(o => (
            <option key={o.id} value={o.id}>{o.name} ({o.type === 'big' ? '大獭' : o.role?.name || '小獭'})</option>
          ))}
        </select>
        <p className="text-xs text-stone-400 mt-2">加载后 Otter 将获得此 Skill 的调用权限，解散时自动回收。</p>
      </Modal>
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<SkillsPage />)
