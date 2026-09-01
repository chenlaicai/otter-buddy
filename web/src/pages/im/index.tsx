import { useState, useEffect, useRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'
import type { ChannelStatusDTO, ConnectionDTO, WeixinAccountDTO, WeixinLoginSessionDTO } from '../../api/client'

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
  const [weixinSession, setWeixinSession] = useState<WeixinLoginSessionDTO | null>(null)
  const [startingLogin, setStartingLogin] = useState(false)

  // 会话大厅（connections）
  const [connections, setConnections] = useState<ConnectionWithSession[]>([])
  const [loadingConnections, setLoadingConnections] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newExternalId, setNewExternalId] = useState('')
  const [creating, setCreating] = useState(false)

  // 加载通道状态
  const loadChannelStatus = useCallback(async () => {
    try {
      const resp = await api.getChannelStatus()
      setChannelStatus(resp.channels)
    } catch {
      showToast('加载通道状态失败', 'error')
    } finally {
      setLoadingStatus(false)
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

    // 5s 轮询通道状态
    pollTimer.current = window.setInterval(loadChannelStatus, POLL_INTERVAL_MS)
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    }
  }, [loadChannelStatus, loadWeixinAccounts, loadConnections])

  // 微信扫码登录
  const handleStartWeixinLogin = async () => {
    setStartingLogin(true)
    try {
      const session = await api.startWeixinLogin()
      setWeixinSession(session)
      // 轮询登录状态
      const poll = window.setInterval(async () => {
        try {
          const s = await api.getWeixinLogin(session.id)
          setWeixinSession(s)
          if (['success', 'expired', 'error', 'cancelled'].includes(s.status)) {
            window.clearInterval(poll)
            if (s.status === 'success') {
              showToast('微信连接成功', 'success')
              loadWeixinAccounts()
              loadChannelStatus()
            } else if (s.status === 'error') {
              showToast(s.error ?? '登录失败', 'error')
            }
          }
        } catch {
          window.clearInterval(poll)
        }
      }, 2000)
    } catch (err) {
      showToast(err instanceof Error ? err.message : '发起登录失败', 'error')
    } finally {
      setStartingLogin(false)
    }
  }

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

  // 状态渲染辅助
  const getStatusLabel = (state: ChannelStatusDTO['state']) => {
    switch (state.kind) {
      case 'running': return '● 运行中'
      case 'starting': return '🟡 启动中'
      case 'token_stale': return '🔴 token 失效，重新扫码'
      case 'error_backoff': return `🟡 网络异常，自动重试中`
      case 'stopped': return state.reason === 'no_config' ? '⚪ 配置缺失，未运行' : '⚪ 已停止'
      default: return '⚪ 未知状态'
    }
  }

  const getStatusColor = (state: ChannelStatusDTO['state']) => {
    switch (state.kind) {
      case 'running': return 'text-green-600 bg-green-50'
      case 'starting': return 'text-yellow-600 bg-yellow-50'
      case 'token_stale': return 'text-red-600 bg-red-50'
      case 'error_backoff': return 'text-yellow-600 bg-yellow-50'
      case 'stopped': return 'text-stone-500 bg-skeleton'
      default: return 'text-stone-500 bg-skeleton'
    }
  }

  // 微信状态
  const weixinStatus = channelStatus.find(c => c.kind === 'weixin')
  // 飞书状态
  const feishuStatus = channelStatus.find(c => c.kind === 'feishu')

  return (
    <AppLayout activeView="im">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-stone-800 mb-6">IM 总览</h1>

        {/* 微信卡片 */}
        <div className="glass-card rounded-2xl p-6 mb-6">
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
            <button
              onClick={handleStartWeixinLogin}
              disabled={startingLogin}
              className="px-4 py-2 text-sm text-white rounded-xl shadow-glow transition disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
            >
              {startingLogin ? '启动中...' : '重新扫码'}
            </button>
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
                      <span className={`text-xs px-2 py-1 rounded-full ${acc.hasToken ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-500'}`}>
                        {acc.hasToken ? '已授权' : 'token 缺失'}
                      </span>
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

          {/* 微信扫码会话 */}
          {weixinSession && weixinSession.status !== 'cancelled' && (
            <div className="border-t border-stone-200/30 pt-4">
              <p className="text-sm text-stone-600 mb-2">扫码登录会话</p>
              <div className="p-3 rounded-xl bg-white/30">
                <p className="text-xs text-stone-500">
                  状态: {weixinSession.status}
                  {weixinSession.qrcodePng && ' (二维码已生成)'}
                </p>
                {weixinSession.status === 'success' && (
                  <p className="text-xs text-green-600 mt-1">账号 {weixinSession.accountId} 已连接</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 飞书卡片 */}
        <div className="glass-card rounded-2xl p-6 mb-6">
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
            {feishuStatus ? '应用凭证已配置（app_id 掩码显示）' : '未配置飞书凭证，请在 config.yaml 中配置 feishu 段'}
          </p>
          {feishuStatus?.state.kind === 'error_backoff' && feishuStatus.state.errorMsg && (
            <p className="text-xs text-red-500 mt-2">错误: {feishuStatus.state.errorMsg}</p>
          )}
        </div>

        {/* 会话大厅卡片 */}
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
            <div className="space-y-3">
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
                          onClick={() => showToast('进入对话功能开发中', 'info')}
                          className="px-3 py-1.5 text-xs text-white rounded-lg transition"
                          style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
                        >
                          进入对话
                        </button>
                      )}
                    </div>
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