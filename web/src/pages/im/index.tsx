import { useState, useEffect, useRef, useCallback } from 'react'
import { showToast } from '../../components/Toast'
import { QRCodeLoginCard } from '../../components/weixin/QRCodeLoginCard'
import * as api from '../../api/client'
import type { ChannelStatusDTO, WeixinAccountDTO } from '../../api/client'

const POLL_INTERVAL_MS = 5000

/**
 * F20260920imax：IM 页按助理模式重组（增量三语义修正）。
 * - 语义根基：微信 bot = 号主私有（一个号 = 一条助理线，扫码时必填名创建）；
 *   飞书 bot 有归属（所有人私聊汇入同一条「飞书助理」专线，消息带姓名前缀）
 * - 微信卡：扫码登录 → 必填命名弹层 → 建线（开户时机 = 登录成功，非首条消息）
 * - 飞书卡：applink 二维码（未加→添加；已加→直达对话）
 * - 群聊绑定区：移除（存量群绑定后端继续工作）
 */
export default function ImPage() {
  // 通道状态
  const [channelStatus, setChannelStatus] = useState<ChannelStatusDTO[]>([])
  const pollTimer = useRef<number | null>(null)

  // 微信账号
  const [weixinAccounts, setWeixinAccounts] = useState<WeixinAccountDTO[]>([])
  const [loadingAccounts, setLoadingAccounts] = useState(true)

  // 助理对话列表（账号→对话对应关系展示）
  const [assistantConvs, setAssistantConvs] = useState<Array<{ id: string; title: string; lastMessageTs?: string | null; lastMessagePreview?: string | null }>>([])

  // F20260920imax：扫码登录成功 → 必填命名弹层（建助理线；名字不许空，无默认值）
  const [naming, setNaming] = useState<{ accountId: string } | null>(null)
  const [nameValue, setNameValue] = useState('')
  const [creatingLine, setCreatingLine] = useState(false)

  const handleLoginSuccess = async () => {
    try {
      const accounts = await api.listWeixinAccounts()
      setWeixinAccounts(accounts)
      loadChannelStatus()
      // 最新账号 = 刚扫的这个；后端幂等（已建线重复提交返回现有对话，不重复建）
      const latest = accounts[accounts.length - 1]
      if (latest) {
        setNaming({ accountId: latest.id })
        setNameValue('')
      }
    } catch {
      // 失败不阻塞——账号列表由既有轮询刷新
    }
  }

  const submitNaming = async () => {
    if (!naming) return
    const name = nameValue.trim()
    if (!name) { showToast('必须给助理起个名字', 'error'); return }
    setCreatingLine(true)
    try {
      await api.provisionWeixinAssistantLine(naming.accountId, name)
      showToast(`助理「${name}」已就绪`, 'success')
      setNaming(null)
      loadAssistantConversations()
    } catch {
      showToast('创建失败，请重试', 'error')
    } finally {
      setCreatingLine(false)
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
  const loadAssistantConversations = useCallback(async () => {
    try {
      const items = await api.listConversations({ limit: 200 })
      setAssistantConvs(items.filter(c => c.kind === 'assistant'))
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
    if (!confirm('确定删除该微信账号？删除后需重新扫码')) return
    try {
      await api.deleteWeixinAccount(accountId)
      showToast('已删除', 'success')
      loadWeixinAccounts()
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
              扫码登录你的微信号，给这条助理线起名后即可用——你在这个号上跟助理私聊，
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
                  <p className="text-xs mt-1">下方扫码开始</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {weixinAccounts.map(acc => {
                    // F20260920imax 检视修正：增量三后 title 为用户任意命名，
                    // includes 匹配失效——未匹配到时显示「未建线」并提供起名入口
                    const linked = assistantConvs.find(c => c.title.includes(acc.id))
                    return (
                      <div key={acc.id} className="flex items-center justify-between p-3 rounded-xl bg-white/30">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-stone-800">{linked?.title ?? acc.id}</p>
                          <p className="text-xs text-stone-400 truncate">
                            {linked
                              ? `助理线 · ${linked.lastMessagePreview ?? '暂无消息'}`
                              : '助理线未建立（需起名创建）'}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {!linked && (
                            <button
                              onClick={() => { setNaming({ accountId: acc.id }); setNameValue('') }}
                              className="px-3 py-1.5 text-xs text-white rounded-lg bg-teal-500 hover:bg-teal-600 transition"
                            >
                              起名建线
                            </button>
                          )}
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

            {/* 扫码登录组件 */}
            <QRCodeLoginCard onLoginSuccess={handleLoginSuccess} />
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

        {/* F20260920imax：扫码成功 → 必填命名弹层（无默认值、无跳过——搭档裁决） */}
        {naming && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" role="dialog" aria-label="给助理起名">
            <div className="glass-card rounded-2xl p-6 w-[380px] shadow-xl">
              <h3 className="text-lg font-semibold text-stone-800 mb-1">给这条助理线起个名 🦦</h3>
              <p className="text-xs text-stone-500 mb-4 leading-relaxed">
                扫码成功！这个名字就是这个微信号的助理对话名（比如「我的助理」）。
                <b>必填，创建后不再改。</b>
              </p>
              <input
                autoFocus
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitNaming() }}
                maxLength={60}
                placeholder="输入助理名字（必填）"
                className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-stone-200 bg-white/70 focus:outline-none focus:ring-2 focus:ring-teal-300"
              />
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={submitNaming}
                  disabled={creatingLine || !nameValue.trim()}
                  className="px-4 py-2 text-sm text-white rounded-xl bg-teal-500 hover:bg-teal-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {creatingLine ? '创建中…' : '创建助理'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

