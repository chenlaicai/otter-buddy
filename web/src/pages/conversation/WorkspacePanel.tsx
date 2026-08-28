import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, File, Folder, FolderOpen, ArrowLeft, Loader2 } from 'lucide-react'

/** 工作区文件条目 */
interface WorkspaceEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  path: string
}

/** 工作区文件内容 */
interface WorkspaceFileContent {
  path: string
  content: string
  truncated: boolean
}

interface WorkspacePanelProps {
  conversationId: string
}

export function WorkspacePanel({ conversationId }: WorkspacePanelProps) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [currentPath, setCurrentPath] = useState<string>('')
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

  /** 加载目录内容 */
  const loadDir = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const url = path
        ? `/api/conversations/${conversationId}/workspace?path=${encodeURIComponent(path)}`
        : `/api/conversations/${conversationId}/workspace`
      const res = await fetch(url)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '加载失败' }))
        throw new Error(err.error || '加载失败')
      }
      const data = await res.json()
      setEntries(data.entries)
      setCurrentPath(path || '')
      setSelectedFile(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  /** 加载文件内容 */
  const loadFile = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/workspace/file?path=${encodeURIComponent(path)}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '加载失败' }))
        throw new Error(err.error || '加载失败')
      }
      const data = await res.json()
      setSelectedFile(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
      setSelectedFile(null)
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  /** 初始加载根目录 */
  useEffect(() => {
    loadDir()
  }, [loadDir])

  /** 点击目录项 */
  const handleDirClick = useCallback((entry: WorkspaceEntry) => {
    if (entry.isDirectory) {
      // 切换展开状态
      setExpandedDirs(prev => {
        const next = new Set(prev)
        if (next.has(entry.path)) {
          next.delete(entry.path)
        } else {
          next.add(entry.path)
        }
        return next
      })
      // 加载子目录内容
      loadDir(entry.path)
    } else if (entry.isFile) {
      loadFile(entry.path)
    }
  }, [loadDir, loadFile])

  /** 返回上级目录 */
  const handleBack = useCallback(() => {
    if (!currentPath) return
    const parentPath = currentPath.split('/').slice(0, -1).join('/')
    loadDir(parentPath || undefined)
  }, [currentPath, loadDir])

  /** 渲染文件图标 */
  const renderIcon = (entry: WorkspaceEntry) => {
    if (entry.isDirectory) {
      return expandedDirs.has(entry.path)
        ? <FolderOpen className="w-4 h-4 text-amber-500" />
        : <Folder className="w-4 h-4 text-amber-500" />
    }
    return <File className="w-4 h-4 text-stone-400" />
  }

  /** 渲染面包屑导航 */
  const renderBreadcrumb = () => {
    if (!currentPath) return null
    const parts = currentPath.split('/')
    return (
      <div className="flex items-center gap-1 px-2 py-1.5 text-xs text-stone-500 border-b border-white/20">
        <button
          onClick={() => loadDir()}
          className="hover:text-otter-500 transition"
        >
          根目录
        </button>
        {parts.map((part, index) => {
          const path = parts.slice(0, index + 1).join('/')
          return (
            <span key={path} className="flex items-center gap-1">
              <ChevronRight className="w-3 h-3" />
              <button
                onClick={() => loadDir(path)}
                className="hover:text-otter-500 transition"
              >
                {part}
              </button>
            </span>
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部：返回按钮 + 面包屑 */}
      <div className="flex items-center gap-2 p-2 border-b border-white/20">
        {currentPath && (
          <button
            onClick={handleBack}
            className="p-1 rounded hover:bg-white/30 transition"
            title="返回上级"
          >
            <ArrowLeft className="w-4 h-4 text-stone-500" />
          </button>
        )}
        <span className="text-xs font-semibold text-stone-500 truncate">
          {currentPath || '工作区根目录'}
        </span>
      </div>

      {/* 面包屑导航 */}
      {renderBreadcrumb()}

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="w-4 h-4 animate-spin text-stone-400" />
          </div>
        )}

        {error && (
          <div className="p-3 text-xs text-red-500 bg-red-50 rounded-lg m-2">
            {error}
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="p-4 text-xs text-stone-400 text-center">
            空目录
          </div>
        )}

        {!loading && !error && entries.length > 0 && (
          <div className="p-1">
            {entries.map(entry => (
              <button
                key={entry.path}
                onClick={() => handleDirClick(entry)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition ${
                  selectedFile?.path === entry.path
                    ? 'bg-otter-400/15 text-otter-600'
                    : 'hover:bg-white/30 text-stone-600'
                }`}
              >
                {renderIcon(entry)}
                <span className="text-xs truncate flex-1">{entry.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* 文件预览 */}
        {selectedFile && (
          <div className="border-t border-white/20 p-2">
            <div className="flex items-center gap-2 mb-2">
              <File className="w-4 h-4 text-stone-400" />
              <span className="text-xs font-semibold text-stone-600 truncate">
                {selectedFile.path}
              </span>
              {selectedFile.truncated && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600">
                  已截断
                </span>
              )}
            </div>
            <pre className="text-xs text-stone-700 bg-white/30 rounded-lg p-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all">
              {selectedFile.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
