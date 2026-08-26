import { useState, useEffect } from 'react'
import { Check, Copy, ChevronDown, ChevronRight } from 'lucide-react'
import { Modal, ModalButton } from '../../components/Modal'
import { OtterAvatar } from '../../components/OtterAvatar'
import { HelpIcon } from '../../components/HelpIcon'
import { fetchOtterProfile } from '../../api/client'
import type { OtterProfileDTO } from '@contract/api'
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
      {modal.type === 'otter-detail' && modal.otterId && <OtterDetailModal key={modal.otterId} {...props} />}
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
  weapon: '驱动这只海獭的底层模型，来自创建时的 modelAlias 配置，未指定时用默认模型。',
  skills: '从 .pi/skills 目录发现的流程能力，当前全族群共享同一套；个体差异在武器与心法。',
  tools: '运行时注册的工具全集；部分工具按獭类型/大獭身份门控（注册全量≠都能用）。',
  systemPrompt: '海獭级系统提示词（任务书）。实际生效 prompt 为三层叠加：平台 base + 本心法 + 身份注入；本槽只展示中间层。',
  stats: '发言=消息段数（一段 speak 计 1）；产出=名下链接资源数；对话=参与过的对话数。',
  exp: '经验 = 发言段数 ×1 + 产物数 ×10。纯活跃度参考，不触发任何升级；权重为展示层常量。',
}

/** 装备槽组件（PR-2） */
function EquipmentSlot({ icon, label, helpText, extra, children }: {
  icon: string; label: string; helpText: string; extra?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className="glass-card rounded-xl p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-sm">{icon}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-stone-500">{label}</span>
        <HelpIcon text={helpText} />
        {extra && <span className="ml-auto">{extra}</span>}
      </div>
      {children}
    </div>
  )
}

function OtterDetailModal(props: ModalsProps) {
  const { modal } = props
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [profile, setProfile] = useState<OtterProfileDTO | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  /** 历史世前情摘要展开态（受控，默认全折叠，不持久化）。
   * Why: 多世海獭的长交接词全文渲染会把弹窗内容撑爆（能滚但找不到重点），
   * 折叠后一屏能扫完世数链，需要细看时逐世展开 */
  const [expandedSummaries, setExpandedSummaries] = useState<Record<string, boolean>>({})
  const otter = modal.type === 'otter-detail' ? props.otters.find(o => o.id === modal.otterId) : null
  const otterId = otter?.id

  useEffect(() => {
    if (!otterId) return
    setProfileLoading(true)
    fetchOtterProfile(otterId)
      .then(setProfile)
      .catch(() => setProfile(null))
      .finally(() => setProfileLoading(false))
  }, [otterId])

  if (!otter) return null

  const isBig = otter.type === 'big'
  const sessions: OtterSession[] = props.sessions[otter.id] || []
  const chain: OtterSession[] = sortSessionChain(sessions)
  const activeSession = chain.find(s => s.status === 'active')
  const activeGen = activeSession ? chain.indexOf(activeSession) + 1 : 0

  // 称号徽章：规则化派生（D3），PR-2 启用"高产"
  const badges: string[] = []
  if (isBig) badges.push('族群长老')
  if (activeGen >= 3) badges.push(`${activeGen}世轮回`)
  if (profile && profile.stats.artifactCount >= 10) badges.push('高产')
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
      width="min(580px, 92vw)"
      fullScreenOnMobile
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
        <OtterAvatar otterId={otter.id} name={otter.name} size={48} type={otter.type} />
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

      {/* ═══ 内容双栏（F20260826mwbc 布局改版）：左=身份信息，右=世代交接 ═══
       * Why sm: —— 与 Modal fullScreenOnMobile 的 639px 断点严格互补：
       *  <640px 全屏抽屉必然单列堆叠（世代交接在身份信息下方）；
       *  ≥640px modal 580px 定宽，内容区 540px，两栏各 ~260px。
       *  比 lg: 稳——640~1024px 的分屏/小平板窗口也能享受两栏，且不存在
       *  「全屏抽屉却分栏 / 定宽弹窗却单列」的矛盾中间态。 */}
      <div data-testid="detail-columns" className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start">
        {/* ── 左栏：身份信息（属性 + 装备 + 战绩） ── */}
        <div data-testid="detail-column-identity" className="space-y-5">
          {/* 属性区 + 状态区 */}
          <div className="grid grid-cols-2 gap-4">
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
                {profile && !profileLoading && (() => {
                  const exp = profile.stats.messageCount * 1 + profile.stats.artifactCount * 10
                  if (exp === 0) return null
                  const pct = Math.min(exp, 100)
                  return (
                    <div className="mt-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-500 flex items-center mb-0.5">
                        EXP <HelpIcon text={HELP_TEXT.exp} />
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-stone-200/60 overflow-hidden">
                          {/* Why: scaleX + CSS animation —— transform 不触发 layout，GPU 加速；
                           *  每次弹窗打开（profile 重新拉取）组件重新挂载，动画自然重播 */}
                          <div
                            className="h-full rounded-full bg-otter-400 exp-fill"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-stone-400 tabular-nums">{exp}{exp > 100 ? '（满格）' : ''}</span>
                      </div>
                    </div>
                  )
                })()}
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

          {/* 装备区（PR-2） */}
          {profileLoading ? (
            <div className="space-y-2">
              <div className="h-8 bg-white/20 rounded-xl animate-pulse" />
              <div className="h-8 bg-white/20 rounded-xl animate-pulse" />
            </div>
          ) : profile && (
            <div className="space-y-3">
              {/* ⚔️ 武器：模型描述 + 强项 */}
              {profile.modelAlias && (
                <EquipmentSlot
                  icon="⚔️"
                  label="武器"
                  helpText={HELP_TEXT.weapon}
                >
                  <div className="text-sm font-medium text-stone-800">{profile.modelAlias}</div>
                  {profile.modelDescriptor?.description && (
                    <div className="text-xs text-stone-500 mt-0.5">{profile.modelDescriptor.description}</div>
                  )}
                  {profile.modelDescriptor?.strengths && profile.modelDescriptor.strengths.length > 0 && (
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {profile.modelDescriptor.strengths.map(s => (
                        <span key={s} className="text-[9px] px-1.5 py-0.5 rounded-full bg-teal-400/15 text-teal-600">{s}</span>
                      ))}
                    </div>
                  )}
                </EquipmentSlot>
              )}

              {/* ✨ 技能槽：skills chips 云 */}
              {profile.skills.length > 0 && (
                <EquipmentSlot
                  icon="✨"
                  label="技能槽"
                  helpText={HELP_TEXT.skills}
                  extra={<span className="text-[9px] text-stone-400">族群共享心法库</span>}
                >
                  <div className="flex gap-1 flex-wrap">
                    {profile.skills.map(s => (
                      <span key={s.name} className="text-[10px] px-2 py-0.5 rounded-full bg-stone-100 text-stone-600" title={s.description}>
                        {s.name}
                      </span>
                    ))}
                  </div>
                </EquipmentSlot>
              )}

              {/* 🎒 工具袋：分组折叠 */}
              <EquipmentSlot
                icon="🎒"
                label="工具袋"
                helpText={HELP_TEXT.tools}
                extra={<span className="text-[9px] text-stone-400">{profile.tools.length} 件</span>}
              >
                <button
                  onClick={() => setToolsExpanded(!toolsExpanded)}
                  className="text-xs text-otter-500 hover:text-otter-600 flex items-center gap-0.5"
                >
                  {toolsExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  {toolsExpanded ? '收起' : '展开'}
                </button>
                {toolsExpanded && (
                  <div className="mt-1.5 space-y-1.5">
                    {Object.entries(
                      profile.tools.reduce((acc, t) => {
                        const g = t.group || '其他'
                        ;(acc[g] ??= []).push(t)
                        return acc
                      }, {} as Record<string, typeof profile.tools>)
                    ).map(([group, tools]) => (
                      <div key={group}>
                        <div className="text-[9px] font-semibold text-stone-400 uppercase">{group}</div>
                        <div className="flex gap-1 flex-wrap mt-0.5">
                          {tools.map(t => (
                            <span key={t.name} className="text-[9px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-500" title={t.description}>
                              {t.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </EquipmentSlot>

              {/* 📜 心法：systemPrompt 折叠 */}
              {profile.systemPrompt && (
                <EquipmentSlot
                  icon="📜"
                  label="心法"
                  helpText={HELP_TEXT.systemPrompt}
                  extra={<span className="text-[9px] text-stone-400">约 {profile.systemPrompt.length} 字</span>}
                >
                  <button
                    onClick={() => setPromptExpanded(!promptExpanded)}
                    className="text-xs text-otter-500 hover:text-otter-600 flex items-center gap-0.5"
                  >
                    {promptExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    {promptExpanded ? '收起' : '展开'}
                  </button>
                  {promptExpanded && (
                    <pre className="mt-1.5 text-xs text-stone-600 bg-stone-50 rounded-lg p-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed">
                      {profile.systemPrompt}
                    </pre>
                  )}
                </EquipmentSlot>
              )}
            </div>
          )}

          {/* ═══ 战绩统计行 ═══ */}
          {profile && !profileLoading && (
            <div className="flex items-center gap-3 text-[11px] text-stone-500 flex-wrap">
              <span className="font-semibold uppercase tracking-wider text-[10px] text-stone-400 flex items-center">
                战绩 <HelpIcon text={HELP_TEXT.stats} />
              </span>
              <span>发言 <strong className="text-stone-700">{profile.stats.messageCount}</strong> 段</span>
              <span>产出 <strong className="text-stone-700">{profile.stats.artifactCount}</strong> 件</span>
              <span>对话 <strong className="text-stone-700">{profile.stats.conversationCount}</strong> 场</span>
            </div>
          )}
        </div>

        {/* ═══ 历练区：转世履历（右栏） ═══ */}
        <div data-testid="detail-column-generations">
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
                  {s.summary && s.status === 'active' && (
                    <div data-testid="session-summary" className="text-xs text-stone-700 mt-1.5 leading-relaxed">
                      {`前情：${s.summary}`}
                    </div>
                  )}
                  {s.summary && s.status !== 'active' && (
                    <div className="mt-1.5">
                      <div
                        data-testid="session-summary"
                        className={`text-xs text-stone-700 leading-relaxed ${expandedSummaries[s.id] ? '' : 'line-clamp-3'}`}
                      >
                        {s.summary}
                      </div>
                      {/* 展开切换：风格同心法区（Chevron + 展开/收起）。
                          短摘要不足 3 行时按钮无视觉变化，保留统一交互不搞溢出检测（jsdom 无真实布局，保持简单） */}
                      <button
                        onClick={() => setExpandedSummaries(cur => ({ ...cur, [s.id]: !cur[s.id] }))}
                        className="mt-0.5 text-xs text-otter-500 hover:text-otter-600 flex items-center gap-0.5"
                      >
                        {expandedSummaries[s.id] ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        {expandedSummaries[s.id] ? '收起' : '展开'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
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
