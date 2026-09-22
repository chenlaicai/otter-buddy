import { useState, useEffect, useRef, useCallback } from 'react'
import { showToast } from '../../components/Toast'
import { QRCodeLoginCard } from '../../components/weixin/QRCodeLoginCard'
import * as api from '../../api/client'
import type { ChannelStatusDTO, WeixinAccountDTO } from '../../api/client'

const POLL_INTERVAL_MS = 5000

/**
 * F20260921imux：IM 页按「先名后码」流程重组（搭档 UX 指令）。
 * - 新建流程：点击「新建助理连接」→ 第 1 步输入名字 → 第 2 步显示二维码 → 扫码即建线
 *   （名字是连接的名字，扫码确认后直接 provision——不再有扫码后命名弹层）
 * - 同号覆盖：同一微信（ilinkUserId 相同）重扫时，提醒「已有助理，是否覆盖」——
 *   确认后删旧账号再走建线（对话历史保留在旧对话里，可回看）
 * - 「起名建线」按钮退役：流程前置闭合后无「已扫码未命名」状态，补丁不再需要
 * - 语义根基（F20260920imax）：微信 bot = 号主私有，一个号 = 一条助理线
 */
export default function ImPage() {
  // 通道状态
  const [channelStatus, setChannelStatus] = useState<ChannelStatusDTO[]>([])
  const pollTimer = useRef<number | null>(null)

  // 微信账号
  const [weixinAccounts, setWeixinAccounts] = useState<WeixinAccountDTO[]>([])
  const [loadingAccounts, setLoadingAccounts] = useState(true)

  // F20260921imux：新建流程状态——step 'idle' → 'naming'（输入名）→ 'connecting'（扫码）
  const [flowStep, setFlowStep] = useState<'idle' | 'naming' | 'connecting'>('idle')
  const [nameValue, setNameValue] = useState('')
  const [creatingLine, setCreatingLine] = useState(false)

  // F20260921imux：扫码确认后发现的同号冲突（旧账号）——等用户裁决覆盖/取消
  const [duplicateAccount, setDuplicateAccount] = useState<{ id: string; hasLine: boolean } | null>(null)
  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null)

  const resetFlow = () => {
    setFlowStep('idle')
    setNameValue('')
    setDuplicateAccount(null)
    setPendingAccountId(null)
  }

  // F20260921imux 检视 D1 处置：改同步（无 await，原 async 签名与 JSDoc 误导）
  const startFlow = () => {
    setFlowStep('naming')
    setNameValue('')
  }

  const submitName = async () => {
    const name = nameValue.trim()
    if (!name) { showToast('先给助理起个名字', 'error'); return }
    setFlowStep('connecting')
  }

  /** F20260921imux：扫码确认（success）——查同号冲突，无冲突直接建线 */
  const handleLoginConfirmed = async (accountId?: string) => {
    setPendingAccountId(accountId ?? null)
    try {
      const accounts = await api.listWeixinAccounts()
      setWeixinAccounts(accounts)
      loadChannelStatus()
      // 同号识别：ilinkUserId 与现有账号一致（除本次新扫码产生的记录外）
      const me = accountId ? accounts.find(a => a.id === accountId) : undefined
      const dup = me?.ilinkUserId
        ? accounts.find(a => a.ilinkUserId === me.ilinkUserId && a.id !== accountId)
        : undefined
      if (dup) {
        // 有同号旧账号 → 弹覆盖确认（不自动删，用户拍板）
        setDuplicateAccount({ id: dup.id, hasLine: Boolean(dup.assistantLine) })
        return
      }
      await finalizeLine(accountId)
    } catch {
      showToast('连接成功，但检查账号状态失败——请刷新页面确认', 'error')
    }
  }

  /** 建线（provision）：名字是连接名，扫码确认后立即执行。返回成败供覆盖流程区分错误语义 */
  const finalizeLine = async (accountId?: string | null): Promise<boolean> => {
    const id = accountId ?? pendingAccountId
    const name = nameValue.trim()
    if (!id || !name) return false
    setCreatingLine(true)
    try {
      await api.provisionWeixinAssistantLine(id, name)
      showToast(`助理「${name}」已就绪 🦦`, 'success')
      loadAssistantConversations()
      loadWeixinAccounts()
      resetFlow()
      return true
    } catch {
      showToast('创建失败，请重试', 'error')
      return false
    } finally {
      setCreatingLine(false)
    }
  }

  /** F20260921imux：覆盖确认——删旧账号（对话历史保留）→ 新记录建线。
   *  检视 S1 处置：两步错误语义拆分——delete 失败（未做任何变更，可原地重试）
   *  与 provision 失败（旧已清理，指引重新新建）分别提示，不再合并误导 */
  const confirmOverwrite = async () => {
    if (!duplicateAccount) return
    setCreatingLine(true)
    try {
      await api.deleteWeixinAccount(duplicateAccount.id)
    } catch {
      showToast('旧账号删除失败，未做任何变更', 'error')
      setCreatingLine(false)
      return
    }
    const ok = await finalizeLine(pendingAccountId)
    setDuplicateAccount(null)
    if (!ok) {
      showToast('旧账号已清理，但建线失败——请重新新建助理连接', 'error')
      resetFlow()
    }
  }

  // 加载通道状态
  const loadChannelStatus = useCallback(async () => {
    try {
      const resp = await api.getChannelStatus()
      setChannelStatus(resp.channels)
    } catch {
      showToast('加载通道状态失败', 'error')
    }
  }, [])

  // 加载微信账号
  const loadWeixinAccounts = useCallback(async () => {
    try {
      setWeixinAccounts(await api.listWeixinAccounts())
    } catch {
      showToast('加载微信账号失败', 'error')
    } finally {
      setLoadingAccounts(false)
    }
  }, [])

  // F20260920imax：加载助理对话（IM 助理分组数据源——kind=assistant）
  const [assistantConvs, setAssistantConvs] = useState<Array<{ id: string; title: string; lastMessageTs?: string | null; lastMessagePreview?: string | null }>>([])
  const loadAssistantConversations = useCallback(async () => {
    try {
      const { items } = await api.listConversations({ limit: 200, kind: 'assistant' })
      setAssistantConvs(items)
    } catch {
      // 静默降级——列表失败不阻塞页面主体
    }
  }, [])

  // 初始化 + 轮询
  useEffect(() => {
    loadChannelStatus()
    loadWeixinAccounts()
    loadAssistantConversations()
    pollTimer.current = window.setInterval(loadChannelStatus, POLL_INTERVAL_MS)
    return () => { if (pollTimer.current) window.clearInterval(pollTimer.current) }
  }, [loadChannelStatus, loadWeixinAccounts, loadAssistantConversations])

  const handleDeleteWeixinAccount = async (accountId: string) => {
    // F20260922wxeg：删号即删线（后端会连同助理对话一起移除）——确认文案说清后果
    if (!confirm('确定移除该助理？对应的助理对话将一并删除，之后需重新扫码建线')) return
    try {
      await api.deleteWeixinAccount(accountId)
      showToast('已删除', 'success')
      loadWeixinAccounts()
      loadAssistantConversations()
      loadChannelStatus()
    } catch {
      showToast('删除失败', 'error')
    }
  }

  // 状态展示辅助（通道健康）
  const getStatusColor = (state: ChannelStatusDTO['state']): string => {
    switch (state.kind) {
      case 'ok': return 'bg-green-50 text-green-600'
      case 'degraded': return 'bg-amber-50 text-amber-600'
      case 'error_backoff': return 'bg-red-50 text-red-500'
      default: return 'bg-skeleton text-stone-500'
    }
  }
  const getStatusLabel = (state: ChannelStatusDTO['state']): string => {
    switch (state.kind) {
      case 'ok': return '● 正常'
      case 'degraded': return '● 降级'
      case 'error_backoff': return '● 异常'
      default: return '● 未知'
    }
  }

  /** 微信聚合状态：任一账号 error → error；任一 stale → degraded；否则取首个 */
  const getWeixinAggregateStatus = (): ChannelStatusDTO | undefined => {
    const weixinEntries = channelStatus.filter(c => c.kind === 'weixin')
    if (weixinEntries.length === 0) return undefined
    const hasError = weixinEntries.find(e => e.state.kind === 'error_backoff')
    if (hasError) return hasError
    const hasStale = weixinEntries.find(e => e.state.kind === 'degraded')
    if (hasStale) return hasStale
    return weixinEntries[0]
  }

  const feishuStatus = channelStatus.find(c => c.kind === 'feishu')
  const weixinStatus = getWeixinAggregateStatus()

  return (
    <>
      {/* Why: max-w-6xl —— 双列布局需要更宽画布；4xl 下两卡并排会挤压二维码可读性 */}
      <div className="max-w-6xl w-full mx-auto px-4 py-8">
        {/* 页头：助理定位主 CTA（F20260920imax） */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-stone-800">IM 助理</h1>
          <p className="text-sm text-stone-500 mt-1">
            把海獭助理加到你的微信 / 飞书——私聊免绑定，直接发消息即可
          </p>
        </div>

        {/* Why: 微信/飞书双列并排 —— 两条平级 IM，单列堆叠浪费纵向空间（F20260902imsc）。
            items-start：卡高不一致时短卡不拉伸填高；lg 以下回落单列 */}
        <div className="grid gap-6 lg:grid-cols-2 items-start">
          {/* 微信卡片（主角） */}
          <div className="glass-card rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-stone-800">微信</h2>
                {weixinStatus ? (
                  <span className={`text-xs px-2 py-1 rounded-full ${getStatusColor(weixinStatus.state)}`}>
                    {getStatusLabel(weixinStatus.state)}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-1 rounded-full bg-skeleton text-stone-500">未运行</span>
                )}
              </div>
              <span className="text-[11px] text-stone-400 bg-white/40 px-2.5 py-1 rounded-full">
                一个账号 = 一个助理对话
              </span>
            </div>

            {/* 使用说明 */}
            <p className="text-xs text-stone-500 leading-relaxed mb-4">
              给助理起名并扫码登录你的微信号——之后在这个号上跟助理私聊，
              消息直接进你的海獭系统。断联重扫回到同一条线。
            </p>

            {/* 微信账号列表（每账号一行，含对应助理对话） */}
            <div className="mb-4">
              <p className="text-xs font-medium text-stone-500 mb-2">
                {loadingAccounts ? '加载中...' : `已连接账号 · ${weixinAccounts.length}`}
              </p>
              {loadingAccounts ? (
                <div className="h-16 rounded-xl bg-white/30 animate-pulse" />
              ) : weixinAccounts.length === 0 ? (
                <div className="text-center py-4 text-stone-400">
                  <p className="text-sm">还没有连接的微信账号</p>
                  <p className="text-xs mt-1">下方新建开始</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {weixinAccounts.map(acc => {
                    // F20260921imux：账号→对话映射改后端真相源（assistantLine 投影），
                    // 取代 title.includes(acc.id) 启发式（增量三后必 miss）
                    const linked = acc.assistantLine
                      ? assistantConvs.find(c => c.id === acc.assistantLine!.conversationId)
                      : undefined
                    return (
                      <div key={acc.id} className="flex items-center justify-between p-3 rounded-xl bg-white/30">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-stone-800">{linked?.title ?? '未命名连接'}</p>
                          <p className="text-xs text-stone-400 truncate">
                            {linked
                              ? `助理线 · ${linked.lastMessagePreview ?? '暂无消息'}`
                              : '扫码未完成或助理线异常（可删除后重新新建）'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {(() => {
                            const acctStatus = channelStatus.find(c => c.channelId === `weixin-${acc.id}`)
                            return acctStatus ? (
                              <span className={`text-xs px-2 py-1 rounded-full ${getStatusColor(acctStatus.state)}`}>
                                {getStatusLabel(acctStatus.state)}
                              </span>
                            ) : (
                              <span className="text-xs px-2 py-1 rounded-full bg-skeleton text-stone-500">未运行</span>
                            )
                          })()}
                          <button
                            onClick={() => handleDeleteWeixinAccount(acc.id)}
                            className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg transition"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* F20260921imux：新建流程（先名后码） */}
            {flowStep === 'idle' && (
              <button
                onClick={startFlow}
                className="w-full py-3 text-sm text-white rounded-xl shadow-glow transition hover:opacity-90"
                style={{ background: 'linear-gradient(135deg,#2DD4BF,#14B8A6)' }}
              >
                ＋ 新建助理连接
              </button>
            )}

            {flowStep === 'naming' && (
              <div className="rounded-xl border border-teal-200/60 bg-teal-50/40 p-4">
                <h3 className="text-sm font-semibold text-stone-800 mb-1">第 1 步 · 给助理起名</h3>
                <p className="text-xs text-stone-500 mb-3 leading-relaxed">
                  这个名字就是微信连接的名字（比如「我的微信」）。创建后固定，不再修改。
                </p>
                <input
                  autoFocus
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitName() }}
                  maxLength={60}
                  placeholder="输入助理名字（必填）"
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-stone-200 bg-white/70 focus:outline-none focus:ring-2 focus:ring-teal-300"
                />
                <div className="flex justify-end gap-2 mt-3">
                  <button onClick={resetFlow} className="px-4 py-2 text-sm text-stone-500 hover:text-stone-700">
                    取消
                  </button>
                  <button
                    onClick={submitName}
                    disabled={!nameValue.trim()}
                    className="px-4 py-2 text-sm text-white rounded-xl bg-teal-500 hover:bg-teal-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    下一步：扫码
                  </button>
                </div>
              </div>
            )}

            {flowStep === 'connecting' && (
              <div className="space-y-3">
                <QRCodeLoginCard lineName={nameValue.trim()} onLoginConfirmed={handleLoginConfirmed} />
                <button onClick={() => setFlowStep('naming')} className="text-xs text-stone-400 hover:text-stone-600">
                  ← 返回修改名字
                </button>
              </div>
            )}
          </div>

          {/* 飞书卡片（bot 好友引导） */}
          <div className="glass-card rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-stone-800">飞书</h2>
                {feishuStatus ? (
                  <span className={`text-xs px-2 py-1 rounded-full ${getStatusColor(feishuStatus.state)}`}>
                    {getStatusLabel(feishuStatus.state)}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-1 rounded-full bg-skeleton text-stone-500">未配置</span>
                )}
              </div>
              <span className="text-[11px] text-stone-400 bg-white/40 px-2.5 py-1 rounded-full">
                加 bot 好友即用
              </span>
            </div>

            {/* 三步引导 */}
            <div className="space-y-2.5 mb-4">
              {[
                '打开飞书，搜索你创建的自建应用机器人',
                '把机器人加为好友（或拉进私聊）',
                '直接发条消息——自动开助理对话，免绑定',
              ].map((step, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-teal-50 text-teal-600 text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <p className="text-xs text-stone-600 leading-relaxed">{step}</p>
                </div>
              ))}
            </div>

            <p className="text-sm text-stone-600">
              {feishuStatus ? '应用凭证已配置' : '未配置飞书凭证，请在 config.yaml 中配置 feishu 段'}
            </p>
            {/* #663：掩码 appId 展示 */}
            {feishuStatus?.appIdMasked && (
              <p className="text-xs text-stone-400 mt-1 font-mono">app_id: {feishuStatus.appIdMasked}</p>
            )}
            {feishuStatus?.state.kind === 'error_backoff' && feishuStatus.state.errorMsg && (
              <p className="text-xs text-red-500 mt-2">
                错误: {feishuStatus.state.errorMsg}
                {typeof feishuStatus.state.reconnectAttempts === 'number' && (
                  <span className="ml-2">（已重连 {feishuStatus.state.reconnectAttempts} 次）</span>
                )}
              </p>
            )}
            <p className="text-xs text-stone-400 mt-4 leading-relaxed">
              群聊绑定入口已移除；存量群绑定继续工作（详见 Web 对话列表）。
            </p>
          </div>
        </div>

        {/* F20260921imux：同号覆盖确认（扫码确认后弹） */}
        {duplicateAccount && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" role="dialog" aria-label="同号覆盖确认">
            <div className="glass-card rounded-2xl p-6 w-[400px] shadow-xl">
              <h3 className="text-lg font-semibold text-stone-800 mb-2">这个微信已有助理 🦦</h3>
              <p className="text-sm text-stone-600 leading-relaxed mb-1">
                刚才扫的微信号与已有连接是同一个（{duplicateAccount.hasLine ? '且已建助理线' : '但未完成建线'}）。
              </p>
              <p className="text-xs text-stone-500 leading-relaxed mb-4">
                {duplicateAccount.hasLine
                  ? '覆盖会删除旧连接及其助理对话（对话历史随之移除），新连接用刚才起的名字建线。'
                  : '旧连接未完成建线，覆盖只是清理记录。'}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { resetFlow() }}
                  className="px-4 py-2 text-sm text-stone-500 hover:text-stone-700"
                >
                  不覆盖，取消
                </button>
                <button
                  onClick={confirmOverwrite}
                  disabled={creatingLine}
                  className="px-4 py-2 text-sm text-white rounded-xl bg-teal-500 hover:bg-teal-600 transition disabled:opacity-40"
                >
                  {creatingLine ? '处理中…' : '覆盖，用新名字建线'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* F20260921imux：建线进行中提示（无冲突路径，扫码确认 → provision 完成的窗口） */}
        {flowStep === 'connecting' && pendingAccountId && !duplicateAccount && creatingLine && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
            <div className="glass-card rounded-2xl p-6 shadow-xl text-center">
              <p className="text-sm text-stone-600">正在创建「{nameValue.trim()}」的助理线…</p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
