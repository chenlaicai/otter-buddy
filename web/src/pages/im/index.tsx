import { useState, useEffect, useRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import { QRCodeLoginCard } from '../../components/weixin/QRCodeLoginCard'
import * as api from '../../api/client'
import type { ChannelStatusDTO, ConnectionDTO, WeixinAccountDTO } from '../../api/client'

const POLL_INTERVAL_MS = 5000

interface ConnectionWithSession extends ConnectionDTO {
  currentConversation?: { id: string; title: string }
}

function ImPage() {
  // 通道状态
  const [channelStatus, setChannelStatus] = useState<ChannelStatusDTO[]>([])
  const pollTimer = useRef<number | null>(null)

  // 微信账号
  const [weixinAccounts, setWeixinAccounts] = useState<WeixinAccountDTO[]>([])
  const [loadingAccounts, setLoadingAccounts] = useState(true)

  // 会话大厅（connections）
  const [connections, setConnections] = useState<ConnectionWithSession[]>([])
  const [loadingConnections, setLoadingConnections] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newExternalId, setNewExternalId] = useState('')
  const [creating, setCreating] = useState(false)

  // 进入对话
  const [showEnter, setShowEnter] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Array<{ id: string; title: string; occupiedBy?: string }>>([])
  const [loadingConvs, setLoadingConvs] = useState(false)
  const [entering, setEntering] = useState(false)

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

  // 加载连接列表
  const loadConnections = useCallback(async () => {
    try {
      const conns = await api.listConnections()
      const withSessions = await Promise.all(
        conns.map(async (conn) => {
          try {
            const session = await api.getConnectionSession(conn.id)
            return { ...conn, currentConversation: session ?? undefined }
          } catch {
            return conn
          }
        })
      )
      setConnections(withSessions)
    } catch {
      showToast('加载连接列表失败', 'error')
    } finally {
      setLoadingConnections(false)
    }
  }, [])

  useEffect(() => {
    loadChannelStatus()
    loadWeixinAccounts()
    loadConnections()

    pollTimer.current = window.setInterval(loadChannelStatus, POLL_INTERVAL_MS)
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    }
  }, [loadChannelStatus, loadWeixinAccounts, loadConnections])

  const handleDeleteWeixinAccount = async (accountId: string) => {
    try {
      await api.deleteWeixinAccount(accountId)
      showToast('已删除', 'success')
      loadWeixinAccounts()
      loadChannelStatus()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  // 会话大厅操作
  const handleCreateConnection = async () => {
    if (!newName.trim() || !newExternalId.trim()) {
      showToast('请填写完整信息', 'error')
      return
    }
    setCreating(true)
    try {
      await api.createConnection({ name: newName.trim(), externalId: newExternalId.trim() })
      showToast('连接创建成功', 'success')
      setShowCreate(false)
      setNewName('')
      setNewExternalId('')
      await loadConnections()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '创建失败', 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleLeaveConnection = async (connectionId: string) => {
    try {
      await api.leaveConversation(connectionId)
      showToast('已离开对话', 'success')
      await loadConnections()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error')
    }
  }

  // 进入对话：加载活跃对话列表
  const handleOpenEnter = async (connectionId: string) => {
    setShowEnter(connectionId)
    setLoadingConvs(true)
    try {
      const convs = await api.listActiveConversations()
      setConversations(convs)
    } catch {
      showToast('加载对话列表失败', 'error')
    } finally {
      setLoadingConvs(false)
    }
  }

  const handleEnterConversation = async (connectionId: string, conversationId: string) => {
    setEntering(true)
    try {
      await api.enterConversation(connectionId, { conversationId })
      showToast('已进入对话', 'success')
      setShowEnter(null)
      await loadConnections()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setEntering(false)
    }
  }

  // 状态渲染辅助
  const getStatusLabel = (state: ChannelStatusDTO['state']) => {
    switch (state.kind) {
      case 'running':
        return state.degraded ? '🟡 降级运行中（config 段缺失）' : '● 运行中'
      case 'starting': return '🟡 启动中'
      case 'token_stale': return '🔴 token 失效，重新扫码'
      case 'error_backoff': return '🟡 网络异常，自动重试中'
      case 'stopped':
        return state.reason === 'no_config' ? '⚪ 配置缺失，未运行' : '⚪ 未运行'
      default: return '⚪ 未知状态'
    }
  }

  const getStatusColor = (state: ChannelStatusDTO['state']) => {
    switch (state.kind) {
      case 'running':
        return state.degraded ? 'text-yellow-600 bg-yellow-50' : 'text-green-600 bg-green-50'
      case 'starting': return 'text-yellow-600 bg-yellow-50'
      case 'token_stale': return 'text-red-600 bg-red-50'
      case 'error_backoff': return 'text-yellow-600 bg-yellow-50'
      case 'stopped': return 'text-stone-500 bg-skeleton'
      default: return 'text-stone-500 bg-skeleton'
    }
  }

  // 微信通道级状态聚合：任一 token_stale → token_stale；任一 error_backoff → error_backoff；否则取首个
  const getWeixinAggregateStatus = (): ChannelStatusDTO | undefined => {
    const weixinEntries = channelStatus.filter(c => c.kind === 'weixin')
    if (weixinEntries.length === 0) return undefined
    const hasStale = weixinEntries.find(e => e.state.kind === 'token_stale')
    if (hasStale) return hasStale
    const hasError = weixinEntries.find(e => e.state.kind === 'error_backoff')
    if (hasError) return hasError
    return weixinEntries[0]
  }

  const feishuStatus = channelStatus.find(c => c.kind === 'feishu')
  const weixinStatus = getWeixinAggregateStatus()

  return (
    <AppLayout activeView="im">
      {/* Why: max-w-6xl —— 双列布局需要更宽画布；4xl 下两卡并排会挤压二维码可读性 */}
      <div className="max-w-6xl w-full mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-stone-800 mb-6">IM 总览</h1>

        {/* Why: 微信/飞书双列并排 —— 两条平级 IM，单列堆叠浪费纵向空间且撞破视口（搭档 2026-09-02 反馈，F20260902imsc）。
            items-start：卡高不一致时短卡不拉伸填高；lg 以下回落单列（窄屏并排会挤压二维码） */}
        <div className="grid gap-6 lg:grid-cols-2 items-start mb-6">
        {/* 微信卡片 */}
        <div className="glass-card rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-stone-800">微信</h2>
              {weixinStatus ? (
                <span className={`text-xs px-2 py-1 rounded-full ${getStatusColor(weixinStatus.state)}`}>
                  {getStatusLabel(weixinStatus.state)}
                </span>
              ) : (
                <span className="text-xs px-2 py-1 rounded-full bg-skeleton text-stone-500">
                  未运行
                </span>
              )}
            </div>
          </div>

          {/* 微信账号列表 */}
          <div className="mb-4">
            <p className="text-sm text-stone-600 mb-2">
              {loadingAccounts ? '加载中...' : `${weixinAccounts.length} 个账号`}
            </p>
            {loadingAccounts ? (
              <div className="h-16 rounded-xl bg-white/30 animate-pulse" />
            ) : weixinAccounts.length === 0 ? (
              <div className="text-center py-4 text-stone-400">
                <p className="text-sm">还没有连接的微信账号</p>
                <p className="text-xs mt-1">点击「重新扫码」开始</p>
              </div>
            ) : (
              <div className="space-y-2">
                {weixinAccounts.map(acc => (
                  <div key={acc.id} className="flex items-center justify-between p-3 rounded-xl bg-white/30">
                    <div>
                      <p className="text-sm font-medium text-stone-800">{acc.id}</p>
                      <p className="text-xs text-stone-400">
                        {acc.ilinkUserId ? `扫码人: ${acc.ilinkUserId}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const acctStatus = channelStatus.find(c => c.channelId === `weixin-${acc.id}`)
                        return acctStatus ? (
                          <span className={`text-xs px-2 py-1 rounded-full ${getStatusColor(acctStatus.state)}`}>
                            {getStatusLabel(acctStatus.state)}
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-1 rounded-full bg-skeleton text-stone-500">
                            未运行
                          </span>
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
                ))}
              </div>
            )}
          </div>

          {/* 扫码登录组件（F20260901chun 发现1：使用真 QRCodeLoginCard 组件） */}
          <QRCodeLoginCard onLoginSuccess={() => { loadWeixinAccounts(); loadChannelStatus() }} />
        </div>

        {/* 飞书卡片（与微信并排，见上方 grid Why 注释） */}
        <div className="glass-card rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-stone-800">飞书</h2>
              {feishuStatus ? (
                <span className={`text-xs px-2 py-1 rounded-full ${getStatusColor(feishuStatus.state)}`}>
                  {getStatusLabel(feishuStatus.state)}
                </span>
              ) : (
                <span className="text-xs px-2 py-1 rounded-full bg-skeleton text-stone-500">
                  未配置
                </span>
              )}
            </div>
            <button
              onClick={() => showToast('飞书连接测试功能开发中', 'info')}
              className="px-4 py-2 text-sm text-white rounded-xl shadow-glow transition"
              style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
            >
              连接测试
            </button>
          </div>
          <p className="text-sm text-stone-600">
            {feishuStatus ? '应用凭证已配置' : '未配置飞书凭证，请在 config.yaml 中配置 feishu 段'}
          </p>
          {/* #663：掩码 appId 展示（凭证确认用——多套凭证/多环境时比对当前实例用的是哪套） */}
          {feishuStatus?.appIdMasked && (
            <p className="text-xs text-stone-400 mt-1 font-mono">app_id: {feishuStatus.appIdMasked}</p>
          )}
          {feishuStatus?.state.kind === 'error_backoff' && feishuStatus.state.errorMsg && (
            <p className="text-xs text-red-500 mt-2">
              错误: {feishuStatus.state.errorMsg}
              {/* #663：重连次数（连续重连，恢复后归零） */}
              {typeof feishuStatus.state.reconnectAttempts === 'number' && (
                <span className="ml-2">（已重连 {feishuStatus.state.reconnectAttempts} 次）</span>
              )}
            </p>
          )}
        </div>
        </div>

        {/* 会话大厅卡片：占满整行 —— 连接数可增长，是主要工作区，不与通道卡挤同一列 */}
        <div className="glass-card rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-stone-800">IM 大厅</h2>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 text-sm text-white rounded-xl shadow-glow transition"
              style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
            >
              新建连接
            </button>
          </div>

          {/* 创建连接对话框 */}
          {showCreate && (
            <div className="glass-card p-4 mb-4 rounded-2xl">
              <h3 className="text-sm font-semibold text-stone-700 mb-3">新建连接</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-stone-500 mb-1 block">连接名称</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="例如：飞书群名称"
                    className="w-full px-3 py-2 text-sm rounded-xl border border-stone-200 bg-white/50 focus:outline-none focus:ring-2 focus:ring-stone-300"
                  />
                </div>
                <div>
                  <label className="text-xs text-stone-500 mb-1 block">飞书群 ID</label>
                  <input
                    type="text"
                    value={newExternalId}
                    onChange={(e) => setNewExternalId(e.target.value)}
                    placeholder="oc_xxxxxxxxxxxxxxxx"
                    className="w-full px-3 py-2 text-sm rounded-xl border border-stone-200 bg-white/50 focus:outline-none focus:ring-2 focus:ring-stone-300"
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setShowCreate(false)}
                    className="px-3 py-1.5 text-sm text-stone-600 hover:bg-skeleton rounded-lg transition"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleCreateConnection}
                    disabled={creating}
                    className="px-3 py-1.5 text-sm text-white rounded-lg transition disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
                  >
                    {creating ? '创建中...' : '创建'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 连接列表 */}
          {loadingConnections ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-20 rounded-2xl bg-white/30 animate-pulse" />
              ))}
            </div>
          ) : connections.length === 0 ? (
            <div className="text-center py-8 text-stone-400">
              <p className="text-sm">暂无连接</p>
              <p className="text-xs mt-1">点击"新建连接"开始</p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {/* Why: 连接卡片双列 —— 单列罗列浪费横向空间（搭档 2026-09-02 反馈） */}
              {connections.map(conn => (
                <div key={conn.id} className="glass-card rounded-2xl overflow-hidden">
                  <div className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-stone-800">{conn.name}</h3>
                        <p className="text-xs text-stone-400 mt-0.5">ID: {conn.externalId}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {conn.currentConversation ? (
                          <span className="text-xs px-2 py-1 rounded-full bg-green-50 text-green-600">
                            已连接
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-1 rounded-full bg-skeleton text-stone-500">
                            未连接
                          </span>
                        )}
                      </div>
                    </div>

                    {conn.currentConversation && (
                      <div className="mt-3 p-2 rounded-xl bg-white/30">
                        <p className="text-xs text-stone-500">当前对话</p>
                        <p className="text-sm text-stone-700 mt-0.5">{conn.currentConversation.title}</p>
                      </div>
                    )}

                    <div className="mt-3 flex gap-2">
                      {conn.currentConversation ? (
                        <button
                          onClick={() => handleLeaveConnection(conn.id)}
                          className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg transition"
                        >
                          离开对话
                        </button>
                      ) : (
                        <button
                          onClick={() => handleOpenEnter(conn.id)}
                          className="px-3 py-1.5 text-xs text-white rounded-lg transition"
                          style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
                        >
                          进入对话
                        </button>
                      )}
                    </div>

                    {/* 进入对话：选择活跃对话 */}
                    {showEnter === conn.id && (
                      <div className="mt-3 p-3 rounded-xl bg-white/30">
                        <p className="text-xs text-stone-500 mb-2">选择一个对话进入：</p>
                        {loadingConvs ? (
                          <p className="text-xs text-stone-400">加载中...</p>
                        ) : conversations.length === 0 ? (
                          <p className="text-xs text-stone-400">暂无活跃对话</p>
                        ) : (
                          <div className="space-y-1">
                            {conversations.map(conv => (
                              <button
                                key={conv.id}
                                onClick={() => handleEnterConversation(conn.id, conv.id)}
                                disabled={entering || !!conv.occupiedBy}
                                className="w-full text-left px-3 py-2 text-xs rounded-lg hover:bg-white/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <span className="text-stone-700">{conv.title}</span>
                                {conv.occupiedBy && (
                                  <span className="text-stone-400 ml-2">（已被 {conv.occupiedBy} 占用）</span>
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                        <button
                          onClick={() => setShowEnter(null)}
                          className="mt-2 text-xs text-stone-400 hover:text-stone-600"
                        >
                          取消
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  )
}

// 渲染
const root = createRoot(document.getElementById('root')!)
root.render(<ImPage />)
