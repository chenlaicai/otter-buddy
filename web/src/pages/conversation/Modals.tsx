import { useState } from 'react'
import { Modal, ModalButton } from '../../components/Modal'
import type { LocalOtter as Otter, LocalOtterSession as OtterSession } from '../../lib/mappers'

interface Skill { id: string; name: string; desc: string; type: string; assignedTo: string[] }
const mockSkills: Skill[] = [
  { id: 'sk1', name: 'code-review', desc: '代码审查能力', type: 'tool', assignedTo: [] },
  { id: 'sk2', name: 'deep-research', desc: '深度研究能力', type: 'workflow', assignedTo: [] },
  { id: 'sk3', name: 'summary-template', desc: '摘要模板', type: 'prompt_template', assignedTo: [] },
]

export type ModalState =
  | { type: 'none' }
  | { type: 'new-conv' }
  | { type: 'child'; parentId: string }
  | { type: 'complete'; cid: string }
  | { type: 'archive'; cid: string }
  | { type: 'create-otter' }
  | { type: 'dissolve'; otterId: string }
  | { type: 'restart'; otterId: string }
  | { type: 'otter-detail'; otterId: string }
  | { type: 'link-resource' }

interface ModalsProps {
  modal: ModalState
  otters: Otter[]
  sessions: Record<string, OtterSession[]>
  onClose: () => void
  onConfirmNewConv: (title: string) => void
  onConfirmChild: (title: string) => void
  onConfirmComplete: () => void
  onConfirmArchive: () => void
  onConfirmCreateOtter: (name: string, role: string, resp: string[]) => void
  onConfirmDissolve: (summary: string) => void
  onConfirmRestart: (summary: string) => void
  onConfirmLinkResource: (type: string, url: string, title: string) => void
  onOpenRestart: (otterId: string) => void
  onOpenDissolve: (otterId: string) => void
}

export function ConversationModals(props: ModalsProps) {
  const { modal } = props

  return (
    <>
      {modal.type === 'new-conv' && <NewConvModal {...props} />}
      {modal.type === 'child' && <ChildModal {...props} />}
      {modal.type === 'complete' && <CompleteModal {...props} />}
      {modal.type === 'archive' && <ArchiveModal {...props} />}
      {modal.type === 'create-otter' && <CreateOtterModal {...props} />}
      {modal.type === 'dissolve' && <DissolveModal {...props} />}
      {modal.type === 'restart' && <RestartModal {...props} />}
      {modal.type === 'otter-detail' && <OtterDetailModal {...props} />}
      {modal.type === 'link-resource' && <LinkResourceModal {...props} />}
    </>
  )
}

function NewConvModal(props: ModalsProps) {
  const [title, setTitle] = useState('')
  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="新建对话"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="primary" onClick={() => { if (title.trim()) { props.onConfirmNewConv(title); setTitle('') } }}>
            创建
          </ModalButton>
        </>
      }
    >
      <label className="block text-xs font-medium text-stone-500 mb-1.5">对话标题</label>
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && title.trim()) { props.onConfirmNewConv(title); setTitle('') } }}
        className="form-input w-full"
        placeholder="输入对话标题"
        autoFocus
      />
      <div className="mt-3">
        <span className="text-xs font-medium text-stone-500">参与 Otter</span>
        <div className="text-sm text-stone-400 mt-1">大獭 (默认)</div>
      </div>
    </Modal>
  )
}

function ChildModal(props: ModalsProps) {
  const [title, setTitle] = useState('')
  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="创建子对话"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="primary" onClick={() => { if (title.trim()) { props.onConfirmChild(title); setTitle('') } }}>
            创建
          </ModalButton>
        </>
      }
    >
      <label className="block text-xs font-medium text-stone-500 mb-1.5">子对话标题</label>
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && title.trim()) { props.onConfirmChild(title); setTitle('') } }}
        className="form-input w-full"
        placeholder="输入子对话标题"
        autoFocus
      />
      <p className="text-xs text-stone-400 mt-2">子对话将继承父对话的链接资源</p>
    </Modal>
  )
}

function CompleteModal(props: ModalsProps) {
  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="完成对话"
      width="400px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="primary" onClick={props.onConfirmComplete}>确认完成</ModalButton>
        </>
      }
    >
      <p className="text-sm text-stone-500">完成此对话？子对话未完成时父对话也可完成。</p>
    </Modal>
  )
}

function ArchiveModal(props: ModalsProps) {
  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="归档对话"
      width="400px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="primary" onClick={props.onConfirmArchive}>确认归档</ModalButton>
        </>
      }
    >
      <p className="text-sm text-stone-500">归档后对话可检索但不活跃。输入框将被禁用。</p>
    </Modal>
  )
}

function CreateOtterModal(props: ModalsProps) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [resp, setResp] = useState('')

  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="创建小獭"
      width="560px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="primary" onClick={() => {
            if (!name.trim()) return
            props.onConfirmCreateOtter(name, role, resp ? resp.split('\n').filter(Boolean) : [])
            setName(''); setRole(''); setResp('')
          }}>
            创建
          </ModalButton>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1.5">小獭名称</label>
          <input value={name} onChange={e => setName(e.target.value)} className="form-input w-full" placeholder="如：分析獭" autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1.5">角色名称</label>
          <input value={role} onChange={e => setRole(e.target.value)} className="form-input w-full" placeholder="如：方案A视角" />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1.5">角色职责（每行一条）</label>
          <textarea value={resp} onChange={e => setResp(e.target.value)} className="form-input w-full resize-none min-h-[60px]" placeholder="从用户体验角度分析&#10;关注易用性" />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1.5">能力选择</label>
          <div className="glass-card rounded-xl p-2.5 space-y-1.5">
            {mockSkills.map(s => (
              <label key={s.id} className="flex items-center gap-2 text-xs cursor-pointer text-stone-600">
                <input type="checkbox" className="rounded" /> {s.name} ({s.type})
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1.5">上下文注入（大獭自动提取，可编辑）</label>
          <textarea className="form-input w-full resize-none min-h-[60px]" placeholder="大獭将从记忆系统中提取相关上下文注入小獭..." />
        </div>
      </div>
    </Modal>
  )
}

function DissolveModal(props: ModalsProps) {
  const { modal } = props
  const otter = modal.type === 'dissolve' ? props.otters.find(o => o.id === modal.otterId) : null
  const [summary, setSummary] = useState('小獭已完成分析任务，关键结论已记录。')

  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="解散小獭"
      width="420px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="danger" onClick={() => props.onConfirmDissolve(summary)}>确认解散</ModalButton>
        </>
      }
    >
      <p className="text-sm text-stone-500">
        解散小獭 <strong className="text-otter-500">{otter?.name}</strong>？Session 将归档到大獭历史记忆，已加载能力将回收。
      </p>
      <div className="mt-3">
        <label className="block text-xs font-medium text-stone-500 mb-1.5">归档摘要（可编辑）</label>
        <textarea
          value={summary}
          onChange={e => setSummary(e.target.value)}
          className="form-input w-full resize-none min-h-[60px]"
        />
      </div>
    </Modal>
  )
}

function RestartModal(props: ModalsProps) {
  const { modal } = props
  const otter = modal.type === 'restart' ? props.otters.find(o => o.id === modal.otterId) : null
  const [summary, setSummary] = useState('之前讨论了 UI 布局方案，但方向有偏差，需要换角度重新分析。')

  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="重启獭生"
      width="420px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="danger" onClick={() => props.onConfirmRestart(summary)}>确认重启</ModalButton>
        </>
      }
    >
      <p className="text-sm text-stone-500">
        重启 <strong className="text-otter-500">{otter?.name}</strong> 的獭生将封存当前 Session 为反面案例，并开新 Session 换角度重来。
      </p>
      <div className="mt-3">
        <label className="block text-xs font-medium text-stone-500 mb-1.5">前情摘要（可编辑）</label>
        <textarea
          value={summary}
          onChange={e => setSummary(e.target.value)}
          className="form-input w-full resize-none min-h-[60px]"
        />
      </div>
    </Modal>
  )
}

function OtterDetailModal(props: ModalsProps) {
  const { modal } = props
  const otter = modal.type === 'otter-detail' ? props.otters.find(o => o.id === modal.otterId) : null
  if (!otter) return null

  const sessions: OtterSession[] = props.sessions[otter.id] || []
  const otterSkills: Skill[] = mockSkills.filter(s => s.assignedTo.includes(otter.id))

  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="Otter 详情"
      width="580px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>关闭</ModalButton>
          {otter.type === 'big' ? (
            <ModalButton variant="danger" onClick={() => { props.onClose(); props.onOpenRestart(otter.id) }}>
              重启獭生
            </ModalButton>
          ) : (
            <ModalButton variant="danger" onClick={() => { props.onClose(); props.onOpenDissolve(otter.id) }}>
              解散小獭
            </ModalButton>
          )}
        </>
      }
    >
      <div className="flex gap-6 mb-4">
        <div className="flex-1 space-y-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">名称</div>
            <div className="text-sm mt-0.5 text-stone-700">{otter.name}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">类型</div>
            <div className="text-sm mt-0.5 text-stone-700">{otter.type === 'big' ? '大獭' : '小獭'}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">角色</div>
            <div className="text-sm mt-0.5 text-stone-700">{otter.role?.name || '-'}</div>
          </div>
        </div>
        <div className="flex-1 space-y-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">职责列表</div>
            <ul className="text-sm mt-0.5 list-disc pl-4 text-stone-700">
              {otter.role?.resp?.length ? otter.role.resp.map((r, i) => <li key={i}>{r}</li>) : <li>-</li>}
            </ul>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">创建时间</div>
            <div className="text-sm mt-0.5 text-stone-700">{otter.createdAt}</div>
          </div>
        </div>
      </div>

      <div className="mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">Session Chain</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-stone-400 border-b border-white/30">
              <th className="py-1.5 px-2 text-left">状态</th>
              <th className="py-1.5 px-2 text-left">开始</th>
              <th className="py-1.5 px-2 text-left">归档</th>
              <th className="py-1.5 px-2 text-left">原因</th>
              <th className="py-1.5 px-2 text-left">反面</th>
              <th className="py-1.5 px-2 text-left">摘要</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map(s => (
              <tr key={s.id} className="border-b border-white/20">
                <td className="py-1.5 px-2 text-xs text-stone-600">
                  {s.status === 'active' ? '✓ 活跃' : '归档'}
                </td>
                <td className="py-1.5 px-2 text-xs text-stone-600">{s.startedAt}</td>
                <td className="py-1.5 px-2 text-xs text-stone-600">{s.archivedAt || '-'}</td>
                <td className="py-1.5 px-2 text-xs text-stone-600">{s.archiveReason || '-'}</td>
                <td className="py-1.5 px-2 text-xs text-stone-600">{s.isNegativeCase ? '是' : '-'}</td>
                <td className="py-1.5 px-2 text-xs text-stone-600">{s.summary || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">已加载能力</div>
        <div className="flex gap-1.5 flex-wrap">
          {otterSkills.length ? otterSkills.map(s => (
            <span key={s.id} className="text-xs font-medium px-2 py-0.5 rounded-full bg-white/40 text-stone-600">{s.name}</span>
          )) : <span className="text-xs text-stone-400">无已加载能力</span>}
        </div>
      </div>
    </Modal>
  )
}

function LinkResourceModal(props: ModalsProps) {
  const [type, setType] = useState('')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')

  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="链接资源"
      width="420px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="primary" onClick={() => {
            if (!url.trim()) return
            props.onConfirmLinkResource(type || 'url', url, title || url)
            setType(''); setUrl(''); setTitle('')
          }}>
            链接
          </ModalButton>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1.5">资源类型（开放机制）</label>
          <input value={type} onChange={e => setType(e.target.value)} className="form-input w-full" placeholder="如: pr, file, url, branch..." />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1.5">URL</label>
          <input value={url} onChange={e => setUrl(e.target.value)} className="form-input w-full" placeholder="https://..." />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1.5">标题（可选）</label>
          <input value={title} onChange={e => setTitle(e.target.value)} className="form-input w-full" placeholder="资源标题" />
        </div>
      </div>
    </Modal>
  )
}
