import { useState, useEffect, useRef, useCallback } from 'react'
import { showToast } from '../../components/Toast'
import { QRCodeLoginCard } from '../../components/weixin/QRCodeLoginCard'
import { FeishuQRCodeLoginCard } from '../../components/feishu/FeishuQRCodeLoginCard'
import * as api from '../../api/client'
import type { ChannelStatusDTO, WeixinAccountDTO, FeishuAppDTO } from '../../api/client'

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
  // #1211：存量 feishu 静态凭证段检测（/api/channels/status 顶层 deprecatedFeishuConfig）——
  // true 时飞书区块顶部渲染迁移引导条（旧配置已退役，避免误导性的「未配置」）
  const [deprecatedFeishuConfig, setDeprecatedFeishuConfig] = useState(false)
  const pollTimer = useRef<number | null>(null)

  // 微信账号
  const [weixinAccounts, setWeixinAccounts] = useState<WeixinAccountDTO[]>([])
  const [loadingAccounts, setLoadingAccounts] = useState(true)

  // F20260921imux：新建流程状态——step 'idle' → 'naming'（输入名）→ 'connecting'（扫码）
  const [flowStep, setFlowStep] = useState<'idle' | 'naming' | 'connecting'>('idle')
  const [nameValue, setNameValue] = useState('')
  // F20260928wxid：扫码人自报称呼（可空）——存 connection.metadata.userName，入站消息据此显示/快照 senderName
  const [userNameValue, setUserNameValue] = useState('')
  const [creatingLine, setCreatingLine] = useState(false)

  // F20260921imux：扫码确认后发现的同号冲突（旧账号）——等用户裁决覆盖/取消
  const [duplicateAccount, setDuplicateAccount] = useState<{ id: string; hasLine: boolean } | null>(null)
  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null)

  // F20260928fsqr：飞书扫码接入——step 'idle' → 'naming'（起名，流入 appPreset 预填）→ 'connecting'（扫码）
  const [feishuFlowStep, setFeishuFlowStep] = useState<'idle' | 'naming' | 'connecting'>('idle')
  const [feishuNameValue, setFeishuNameValue] = useState('')
  const [feishuApps, setFeishuApps] = useState<FeishuAppDTO[]>([])

  const loadFeishuApps = useCallback(async () => {
    try {
      setFeishuApps(await api.listFeishuApps())
    } catch {
      // 后端未启用扫码接入（旧版本）时静默——入口仅在有响应时展示账号列表
    }
  }, [])

  useEffect(() => {
    loadFeishuApps()
  }, [loadFeishuApps])

  const resetFlow = () => {
    setFlowStep('idle')
    setNameValue('')
    setUserNameValue('')
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
    const userName = userNameValue.trim()
    if (!id || !name) return false
    setCreatingLine(true)
    try {
      await api.provisionWeixinAssistantLine(id, name, userName || undefined)
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
      setDeprecatedFeishuConfig(resp.deprecatedFeishuConfig === true)
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

  // F20260928wxid：存量线补/改称呼（新线在扫码时填；这条是存量兜底通道）
  const handleEditUserName = async (accountId: string, current?: string) => {
    const input = prompt('你的称呼（助理会这样称呼你；留空 = 清除，恢复 ID 展示）', current ?? '')
    if (input === null) return  // 取消
    const trimmed = input.trim()
    if (trimmed.length > 60) { showToast('称呼最长 60 字符', 'error'); return }
    try {
      await api.updateWeixinUserName(accountId, trimmed)
      showToast(trimmed ? `称呼已更新为「${trimmed}」` : '称呼已清除', 'success')
      loadWeixinAccounts()
    } catch {
      showToast('更新失败，请重试', 'error')
    }
  }

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

  // 状态展示辅助（通道健康）F20260928wxid：恢复 #655 五态完整映射
  // （#1055 重写时误写 ok/degraded 三态，后端从无此 kind，致 running/token_stale/stopped 全落「未知」）
  const getStatusColor = (state: ChannelStatusDTO['state']): string => {
    switch (state.kind) {
      case 'running': return state.degraded ? 'bg-amber-50 text-amber-600' : 'bg-green-50 text-green-600'
      case 'starting': return 'bg-amber-50 text-amber-600'
      case 'token_stale': return 'bg-red-50 text-red-500'
      case 'error_backoff': return 'bg-red-50 text-red-500'
      default: return 'bg-skeleton text-stone-500'
    }
  }
  const getStatusLabel = (state: ChannelStatusDTO['state']): string => {
    switch (state.kind) {
      case 'running': return state.degraded ? '🟡 降级运行中' : '● 运行中'
      case 'starting': return '🟡 启动中'
      case 'token_stale': return '🔴 token 失效，重新扫码'
      case 'error_backoff': return '🟡 网络异常，自动重试中'
      case 'stopped': return '○ 已停止'
      default: return '● 未知'
    }
  }

  /** 微信聚合状态：任一 error_backoff → 优先；任一 token_stale → 次优先；任一 running.degraded → 三优先；否则取首个
   *  F20260928wxid：hasStale 原找 kind='degraded'（不存在的值）→ token_stale 永远漏报；
   *  检视建议 1：多账号时任一账号 running.degraded 不设防会被绿色掩盖，补三优先级 */
  const getWeixinAggregateStatus = (): ChannelStatusDTO | undefined => {
    const weixinEntries = channelStatus.filter(c => c.kind === 'weixin')
    if (weixinEntries.length === 0) return undefined
    const hasError = weixinEntries.find(e => e.state.kind === 'error_backoff')
    if (hasError) return hasError
    const hasStale = weixinEntries.find(e => e.state.kind === 'token_stale')
    if (hasStale) return hasStale
    const hasDegraded = weixinEntries.find(e => e.state.kind === 'running' && e.state.degraded)
    if (hasDegraded) return hasDegraded
    return weixinEntries[0]
  }

  /** 飞书聚合状态：扫码线多实例（kind=feishu-bot:*），聚合优先级照微信先例
   *  F20260929fsqr（delta 检视建议 6）：静态 kind='feishu' 键随退役消失，纯扫码模式下
   *  原单键 find 恒 miss → 徽标恒「未配置」——改前缀聚合。
   *  O1 注：无 token_stale 档——飞书 WS 模式当前不可达该态（long-connection-client 仅报
   *  running/error_backoff）；未来若引入 token_stale 需在此补档 */
  const getFeishuAggregateStatus = (): ChannelStatusDTO | undefined => {
    const feishuEntries = channelStatus.filter(c => c.kind.startsWith('feishu-bot:'))
    if (feishuEntries.length === 0) return undefined
    const hasError = feishuEntries.find(e => e.state.kind === 'error_backoff')
    if (hasError) return hasError
    const hasDegraded = feishuEntries.find(e => e.state.kind === 'running' && e.state.degraded)
    if (hasDegraded) return hasDegraded
    return feishuEntries[0]
  }

  const feishuStatus = getFeishuAggregateStatus()
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
                          {/* F20260928wxid：称呼展示 + 存量线编辑入口 */}
                          <button
                            onClick={() => handleEditUserName(acc.id, acc.userName)}
                            className={`px-3 py-1.5 text-xs rounded-lg transition ${acc.userName ? 'text-teal-600 hover:bg-teal-50' : 'text-stone-400 hover:bg-stone-100'}`}
                            title="设置你的称呼（助理会这样叫你）"
                          >
                            {acc.userName ? `@${acc.userName}` : '设置称呼'}
                          </button>
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
                {/* F20260928wxid：扫码人自报称呼（可空）——微信无查名 API，自报是唯一解；
                    空则维持现状（裸 ID 展示），不强制增加扫码摩擦 */}
                <input
                  value={userNameValue}
                  onChange={(e) => setUserNameValue(e.target.value)}
                  maxLength={60}
                  placeholder="你的称呼（选填，如 joy）——助理就能叫出你的名字"
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-stone-200 bg-white/70 focus:outline-none focus:ring-2 focus:ring-teal-300 mt-2"
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

            {/* #1211：存量静态凭证迁移引导——检测到旧 feishu 段时置顶提示，
                指向扫码迁移（选已有应用）；完整步骤内嵌，不依赖外部链接
                （web SPA 无 docs 静态服务，外链会 fallback 到首页成死链） */}
            {deprecatedFeishuConfig && (
              <div className="mb-4 rounded-xl border border-amber-200/70 bg-amber-50/80 px-4 py-3" data-testid="feishu-migration-banner">
                <p className="text-xs font-medium text-amber-800">
                  检测到旧版飞书静态凭证配置（config.yaml feishu 段已退役）
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-amber-700">
                  飞书接入已切换为扫码模式，请迁移：① 删除 config.yaml 中整个 feishu: 段（含 partnerOpenId）→ ② 重启 otter-buddy → ③ 在本页扫码，确认页选「选择已有应用」重新接入原应用。历史对话绑定不受影响。完整说明见仓库 docs/user-guide/feishu-setup.md「从旧静态凭证迁移」节。
                </p>
              </div>
            )}

            {/* 三步引导：未配置态指向扫码流程，已配置态指向加好友开聊（F20260929fsqr 扫码文案对齐） */}
            <div className="space-y-2.5 mb-4">
              {(feishuStatus
                ? [
                    '打开飞书，搜索你创建的自建应用机器人',
                    '把机器人加为好友（或拉进私聊）',
                    '直接发条消息——自动开助理对话，免绑定',
                  ]
                : [
                    '点下方「扫码接入飞书」，给助理起个名字',
                    '用飞书扫二维码，确认页可选「创建新应用」或「选择已有应用」',
                    '完成后在飞书搜索助理名，加好友即用',
                  ]
              ).map((step, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-teal-50 text-teal-600 text-[11px] font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <p className="text-xs text-stone-600 leading-relaxed">{step}</p>
                </div>
              ))}
            </div>

            <p className="text-sm text-stone-600">
              {feishuStatus ? '应用凭证已配置' : '未配置飞书凭证——扫码即可接入，无需任何凭证'}
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

            {/* F20260928fsqr：扫码接入（registerApp 免凭证）——起名 + 扫码两步 */}
            {feishuFlowStep === 'naming' && (
              <div className="mt-4 space-y-3">
                <input
                  value={feishuNameValue}
                  onChange={(e) => setFeishuNameValue(e.target.value)}
                  placeholder="给助理起个名字（如 joy 的小助手）"
                  maxLength={60}
                  className="w-full px-3 py-2 text-sm rounded-xl border border-stone-200 bg-white/60 focus:outline-none focus:ring-2 focus:ring-teal-400/40"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setFeishuFlowStep('idle')} className="text-xs text-stone-400 hover:text-stone-600">
                    取消
                  </button>
                  <button
                    onClick={() => setFeishuFlowStep('connecting')}
                    disabled={!feishuNameValue.trim()}
                    className="px-4 py-2 text-sm text-white rounded-xl bg-teal-500 hover:bg-teal-600 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    下一步：扫码
                  </button>
                </div>
              </div>
            )}
            {feishuFlowStep === 'connecting' && (
              <div className="mt-4 space-y-3">
                <FeishuQRCodeLoginCard
                  lineName={feishuNameValue.trim()}
                  onLoginConfirmed={() => {
                    setFeishuFlowStep('idle')
                    setFeishuNameValue('')
                    loadFeishuApps()
                  }}
                />
                <button onClick={() => setFeishuFlowStep('naming')} className="text-xs text-stone-400 hover:text-stone-600">
                  ← 返回修改名字
                </button>
              </div>
            )}
            {feishuFlowStep === 'idle' && (
              <button
                onClick={() => setFeishuFlowStep('naming')}
                className="mt-4 px-4 py-2 text-sm text-white rounded-xl bg-teal-500 hover:bg-teal-600 transition"
              >
                + 扫码接入飞书
              </button>
            )}

            {/* 扫码账号列表（多 app 并行；删除入口） */}
            {feishuApps.length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="text-xs text-stone-400">扫码接入的账号</p>
                {feishuApps.map((app) => (
                  <div key={app.appId} className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/40">
                    <div className="min-w-0">
                      <p className="text-sm text-stone-700 truncate">{app.name ?? '未命名助理'}</p>
                      <p className="text-[11px] text-stone-400 font-mono">{app.appId}{app.assistantLine ? ' · 已建线' : ' · 未建线'}</p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!window.confirm(`删除「${app.name ?? app.appId}」？将停止其消息通道与助理线绑定。`)) return
                        try {
                          await api.deleteFeishuApp(app.appId)
                          showToast('已删除', 'success')
                          loadFeishuApps()
                        } catch (err) {
                          showToast(err instanceof Error ? err.message : '删除失败', 'error')
                        }
                      }}
                      className="text-xs text-stone-400 hover:text-red-500 flex-shrink-0"
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
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
