import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Modal, ModalButton } from '../../components/Modal'
import { OtterAvatar } from '../../components/OtterAvatar'
import { HelpIcon } from '../../components/HelpIcon'
import type { LocalOtter as Otter, LocalOtterSession as OtterSession } from '../../lib/mappers'
import { sortSessionChain } from '../../lib/session-chain'

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
      <label className="block text-xs font-medium text-stone-600 mb-1.5">对话标题</label>
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && title.trim()) { props.onConfirmNewConv(title); setTitle('') } }}
        className="form-input w-full"
        placeholder="输入对话标题"
        autoFocus
      />
      <div className="mt-3">
        <span className="text-xs font-medium text-stone-600">参与 Otter</span>
        <div className="text-sm text-stone-500 mt-1">大獭 (默认)</div>
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
      <label className="block text-xs font-medium text-stone-600 mb-1.5">子对话标题</label>
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && title.trim()) { props.onConfirmChild(title); setTitle('') } }}
        className="form-input w-full"
        placeholder="输入子对话标题"
        autoFocus
      />
      <p className="text-xs text-stone-500 mt-2">子对话将继承父对话的关键资源</p>
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
      <p className="text-sm text-stone-600">归档后对话可检索但不活跃。输入框将被禁用。</p>
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
          <label className="block text-xs font-medium text-stone-600 mb-1.5">小獭名称</label>
          <input value={name} onChange={e => setName(e.target.value)} className="form-input w-full" placeholder="如：分析獭" autoFocus />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1.5">角色名称</label>
          <input value={role} onChange={e => setRole(e.target.value)} className="form-input w-full" placeholder="如：方案A视角" />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1.5">角色职责（每行一条）</label>
          <textarea value={resp} onChange={e => setResp(e.target.value)} className="form-input w-full resize-none min-h-[60px]" placeholder="从用户体验角度分析&#10;关注易用性" />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1.5">能力选择</label>
          <div className="glass-card rounded-xl p-2.5 space-y-1.5">
            {mockSkills.map(s => (
              <label key={s.id} className="flex items-center gap-2 text-xs cursor-pointer text-stone-600">
                <input type="checkbox" className="rounded" /> {s.name} ({s.type})
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1.5">上下文注入（大獭自动提取，可编辑）</label>
          <textarea className="form-input w-full resize-none min-h-[60px]" placeholder="大獭将从记忆系统中提取相关上下文注入小獭..." />
        </div>
      </div>
    </Modal>
  )
}

function DissolveModal(props: ModalsProps) {
  const { modal } = props
  const otter = modal.type === 'dissolve' ? props.otters.find(o => o.id === modal.otterId) : null
  const [summary, setSummary] = useState('')

  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="解散小獭"
      width="420px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="danger" onClick={() => { if (summary.trim()) { props.onConfirmDissolve(summary); setSummary('') } }}>确认解散</ModalButton>
        </>
      }
    >
      <p className="text-sm text-stone-600">
        解散小獭 <strong className="text-otter-500">{otter?.name}</strong>？Session 将归档到大獭历史记忆，已加载能力将回收。
      </p>
      <div className="mt-3">
        <label className="block text-xs font-medium text-stone-600 mb-1.5">归档摘要（可编辑）</label>
        <textarea
          value={summary}
          onChange={e => setSummary(e.target.value)}
          placeholder="简要记录小獭的工作成果和关键结论"
          className="form-input w-full resize-none min-h-[60px]"
        />
      </div>
    </Modal>
  )
}

function RestartModal(props: ModalsProps) {
  const { modal } = props
  const otter = modal.type === 'restart' ? props.otters.find(o => o.id === modal.otterId) : null
  const [summary, setSummary] = useState('')

  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="重启獭生"
      width="420px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>取消</ModalButton>
          <ModalButton variant="danger" onClick={() => { if (summary.trim()) { props.onConfirmRestart(summary); setSummary('') } }}>确认重启</ModalButton>
        </>
      }
    >
      <p className="text-sm text-stone-600">
        重启 <strong className="text-otter-500">{otter?.name}</strong> 的獭生将封存当前 Session（前世），以全新上下文开启新一世。前世记录可在详情的 Session Chain 中查看。
      </p>
      <div className="mt-3">
        <label className="block text-xs font-medium text-stone-600 mb-1.5">前情摘要（可编辑）</label>
        <textarea
          value={summary}
          onChange={e => setSummary(e.target.value)}
          placeholder="简要说明重启原因，将作为新一世的前情摘要"
          className="form-input w-full resize-none min-h-[60px]"
        />
      </div>
    </Modal>
  )
}

/** 非安全上下文（局域网 IP 访问 dev server 等）无 clipboard API 时的降级复制 */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { /* 降级也失败则静默，title 仍展示全量 id */ }
  document.body.removeChild(ta)
  return ok
}

/** 属性说明文案常量（D2.1）
 *  与映射表同源维护——改映射必须同步改此处。 */
const HELP_TEXT = {
  level: '等级 = 世数：海獭每次重启獭生（session 封存重开）+1。资历指标，非游戏升级。',
  badge: '称号由规则自动派生：族群长老=大獭；N世轮回=世数≥3；高产=产出≥10；无满足则不显示。',
  type: '大獭=族群长老（持久型，负责统筹和派活）；小獭=任务专员（临时型，完成任务后解散）。',
  sessionChain: '转世履历记录海獭的每次 session 生命周期。重启獭生 = 封存当前 session + 开启新 session。',
}

function OtterDetailModal(props: ModalsProps) {
  const { modal } = props
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const otter = modal.type === 'otter-detail' ? props.otters.find(o => o.id === modal.otterId) : null
  if (!otter) return null

  const isBig = otter.type === 'big'
  const sessions: OtterSession[] = props.sessions[otter.id] || []
  const chain: OtterSession[] = sortSessionChain(sessions)
  const activeSession = chain.find(s => s.status === 'active')
  const activeGen = activeSession ? chain.indexOf(activeSession) + 1 : 0

  // 称号徽章：规则化派生（D3）
  const badges: string[] = []
  if (isBig) badges.push('族群长老')
  if (activeGen >= 3) badges.push(`${activeGen}世轮回`)
  // "高产" 需要 artifactCount，PR-2 数据到位后启用
  if (otter.role?.name) badges.push(otter.role.name)

  const statusEmoji = activeSession ? '🟢' : '💤'
  const statusText = activeSession ? '活跃' : '休眠'

  const copySessionId = (id: string) => {
    const done = () => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(cur => (cur === id ? null : cur)), 1500)
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(id).then(done).catch(() => { if (legacyCopy(id)) done() })
    } else if (legacyCopy(id)) {
      done()
    }
  }

  return (
    <Modal
      isOpen
      onClose={props.onClose}
      title="海獭面板"
      width="580px"
      footer={
        <>
          <ModalButton onClick={props.onClose}>关闭</ModalButton>
          {isBig ? (
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
      {/* ═══ 形象区：头像 + 名称 + 称号徽章 ═══ */}
      <div className="flex items-center gap-4 mb-5">
        <OtterAvatar otterId={otter.id} name={otter.name} size={48} />
        <div className="flex-1 min-w-0">
          <div className="text-lg font-semibold text-stone-800">{otter.name}</div>
          {badges.length > 0 && (
            <div className="flex gap-1.5 mt-1 flex-wrap">
              {badges.slice(0, 3).map(b => (
                <span key={b} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-otter-400/15 text-otter-600">
                  {b}
                </span>
              ))}
              {badges.length > 3 && (
                <span className="text-[10px] text-stone-400">+{badges.length - 3}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ═══ 属性区 + 状态区 ═══ */}
      <div className="grid grid-cols-2 gap-4 mb-5">
        <div className="space-y-2.5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 flex items-center">
              类型 <HelpIcon text={HELP_TEXT.type} />
            </div>
            <div className="text-sm mt-0.5 text-stone-800">{isBig ? '族群长老' : '任务专员'}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 flex items-center">
              等级 <HelpIcon text={HELP_TEXT.level} />
            </div>
            <div className="text-sm mt-0.5 text-stone-800">Lv.{activeGen}</div>
          </div>
          {otter.role?.name && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">角色</div>
              <div className="text-sm mt-0.5 text-stone-800">{otter.role.name}</div>
            </div>
          )}
          {otter.modelAlias && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">模型</div>
              <div className="text-sm mt-0.5 text-stone-800">{otter.modelAlias}</div>
            </div>
          )}
        </div>
        <div className="space-y-2.5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">在线状态</div>
            <div className="text-sm mt-0.5 text-stone-800">{statusEmoji} {statusText}</div>
          </div>
          {activeSession && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">本世启程</div>
              <div className="text-sm mt-0.5 text-stone-800">
                第{activeGen}世 · {activeSession.startedAt}
              </div>
            </div>
          )}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">创建时间</div>
            <div className="text-sm mt-0.5 text-stone-800">{otter.createdAt}</div>
          </div>
        </div>
      </div>

      {/* ═══ 装备区占位（PR-2 扩展） ═══ */}
      <div className="mb-5 p-3 rounded-xl border border-dashed border-stone-300/60">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 text-center">
          装备区 · 武器 / 技能槽 / 工具袋 / 心法
        </div>
        <div className="text-[10px] text-stone-400 text-center mt-0.5">PR-2 实现</div>
      </div>

      {/* ═══ 历练区：转世履历（改名自 Session Chain） ═══ */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 mb-1.5 flex items-center">
          转世履历 <HelpIcon text={HELP_TEXT.sessionChain} />
        </div>
        {chain.length === 0 ? (
          <div className="text-xs text-stone-500">暂无 session 记录</div>
        ) : (
          <div className="space-y-2">
            {chain.map((s, i) => (
              <div
                key={s.id}
                className={`rounded-xl border px-3 py-2 ${
                  s.status === 'active'
                    ? 'border-otter-400/50 bg-otter-400/10'
                    : 'border-stone-300/50 bg-white/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-stone-800">第{i + 1}世</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                    s.status === 'active' ? 'bg-otter-400/20 text-otter-500' : 'bg-stone-400/15 text-stone-500'
                  }`}>
                    {s.status === 'active' ? '当前' : s.status === 'restarted' ? '已重启' : '已归档'}
                  </span>
                  <button
                    onClick={() => copySessionId(s.id)}
                    title={`${s.id}\n点击复制`}
                    className="ml-auto flex items-center gap-1 text-[11px] font-mono text-stone-500 hover:text-stone-700 transition"
                  >
                    {copiedId === s.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {s.id.length > 12 ? `${s.id.slice(0, 8)}…` : s.id}
                  </button>
                </div>
                <div className="text-[11px] text-stone-500 mt-1">
                  开始 {s.startedAt}{s.archivedAt ? ` · 归档 ${s.archivedAt}` : ''}
                </div>
                {s.archiveReason && (
                  <div className="text-xs text-stone-600 mt-1">归档原因：{s.archiveReason}</div>
                )}
                {s.summary && (
                  <div className="text-xs text-stone-700 mt-1.5 leading-relaxed">
                    {s.status === 'active' ? `前情：${s.summary}` : s.summary}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
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
      title="添加关键资源"
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
          <label className="block text-xs font-medium text-stone-600 mb-1.5">资源类型（开放机制）</label>
          <input value={type} onChange={e => setType(e.target.value)} className="form-input w-full" placeholder="如: pr, file, url, branch..." />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1.5">URL</label>
          <input value={url} onChange={e => setUrl(e.target.value)} className="form-input w-full" placeholder="https://..." />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1.5">标题（可选）</label>
          <input value={title} onChange={e => setTitle(e.target.value)} className="form-input w-full" placeholder="资源标题" />
        </div>
      </div>
    </Modal>
  )
}
