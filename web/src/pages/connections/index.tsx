import { useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'
import * as api from '../../api/client'
import type { ConnectionDTO } from '../../api/client'

interface ConnectionWithSession extends ConnectionDTO {
  currentConversation?: { id: string; title: string }
}

function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionWithSession[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newExternalId, setNewExternalId] = useState('')
  const [creating, setCreating] = useState(false)

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
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  const handleCreate = async () => {
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

  const handleLeave = async (connectionId: string) => {
    try {
      await api.leaveConversation(connectionId)
      showToast('已离开对话', 'success')
      await loadConnections()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error')
    }
  }

  return (
    <AppLayout activeView="connections">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-stone-800">连接管理</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm text-white rounded-xl shadow-glow transition"
            style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
          >
            新建连接
          </button>
        </div>

        {/* 创建对话框 */}
        {showCreate && (
          <div className="glass-card p-4 mb-6 rounded-2xl">
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
                  className="px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100 rounded-lg transition"
                >
                  取消
                </button>
                <button
                  onClick={handleCreate}
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
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-20 rounded-2xl bg-white/30 animate-pulse" />
            ))}
          </div>
        ) : connections.length === 0 ? (
          <div className="text-center py-12 text-stone-400">
            <p className="text-sm">暂无连接</p>
            <p className="text-xs mt-1">点击"新建连接"开始</p>
          </div>
        ) : (
          <div className="space-y-3">
            {connections.map(conn => (
              <ConnectionCard
                key={conn.id}
                connection={conn}
                onLeave={handleLeave}
                onRefresh={loadConnections}
              />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  )
}

function ConnectionCard({ connection, onLeave, onRefresh }: {
  connection: ConnectionWithSession
  onLeave: (id: string) => void
  onRefresh: () => void
}) {
  const [showEnter, setShowEnter] = useState(false)
  const [conversations, setConversations] = useState<Array<{ id: string; title: string; occupiedBy?: string }>>([])
  const [loadingConvs, setLoadingConvs] = useState(false)
  const [entering, setEntering] = useState(false)

  const loadConversations = async () => {
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

  const handleEnter = async (conversationId: string) => {
    setEntering(true)
    try {
      await api.enterConversation(connection.id, { conversationId })
      showToast('已进入对话', 'success')
      setShowEnter(false)
      await onRefresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setEntering(false)
    }
  }

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-stone-800">{connection.name}</h3>
            <p className="text-xs text-stone-400 mt-0.5">ID: {connection.externalId}</p>
          </div>
          <div className="flex items-center gap-2">
            {connection.currentConversation ? (
              <span className="text-xs px-2 py-1 rounded-full bg-green-50 text-green-600">
                已连接
              </span>
            ) : (
              <span className="text-xs px-2 py-1 rounded-full bg-stone-100 text-stone-500">
                未连接
              </span>
            )}
          </div>
        </div>

        {connection.currentConversation && (
          <div className="mt-3 p-2 rounded-xl bg-white/30">
            <p className="text-xs text-stone-500">当前对话</p>
            <p className="text-sm text-stone-700 mt-0.5">{connection.currentConversation.title}</p>
          </div>
        )}

        <div className="mt-3 flex gap-2">
          {connection.currentConversation ? (
            <button
              onClick={() => onLeave(connection.id)}
              className="px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-lg transition"
            >
              离开对话
            </button>
          ) : (
            <button
              onClick={() => {
                setShowEnter(true)
                loadConversations()
              }}
              className="px-3 py-1.5 text-xs text-white rounded-lg transition"
              style={{ background: 'linear-gradient(135deg,#8B7E72,#6B6157)' }}
            >
              进入对话
            </button>
          )}
        </div>
      </div>

      {/* 进入对话选择 */}
      {showEnter && (
        <div className="border-t border-stone-200/30 p-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-stone-600">选择对话</h4>
            <button
              onClick={() => setShowEnter(false)}
              className="text-xs text-stone-400 hover:text-stone-600"
            >
              关闭
            </button>
          </div>
          {loadingConvs ? (
            <div className="text-xs text-stone-400">加载中...</div>
          ) : conversations.length === 0 ? (
            <div className="text-xs text-stone-400">暂无可用对话</div>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {conversations.map(conv => (
                <button
                  key={conv.id}
                  onClick={() => handleEnter(conv.id)}
                  disabled={entering || !!conv.occupiedBy}
                  className="w-full text-left px-3 py-2 text-xs rounded-lg hover:bg-white/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="font-medium text-stone-700">{conv.title}</div>
                  {conv.occupiedBy && (
                    <div className="text-stone-400 mt-0.5">已被占用: {conv.occupiedBy}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 渲染
const root = createRoot(document.getElementById('root')!)
root.render(<ConnectionsPage />)
