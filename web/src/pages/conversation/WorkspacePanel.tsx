import { useState, useEffect, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight, FileText, Folder, FolderOpen, Loader2 } from 'lucide-react'

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

/** 按扩展名返回文件类型图标颜色 */
function fileColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['md', 'markdown', 'txt', 'text'].includes(ext)) return 'text-blue-400'
  if (['html', 'htm'].includes(ext)) return 'text-orange-400'
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return 'text-green-400'
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) return 'text-amber-500'
  if (['css', 'scss'].includes(ext)) return 'text-purple-400'
  return 'text-stone-400'
}

/** 判断是否为可渲染内容的扩展名 */
function getExt(name: string): string {
  return (name.split('.').pop()?.toLowerCase() ?? '')
}

/** 排序：文件夹在前、文件在后，各自按名称字母序 */
function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  })
}

/** 从 API 加载目录内容 */
async function fetchDir(conversationId: string, path?: string): Promise<WorkspaceEntry[]> {
  const url = path
    ? `/api/conversations/${conversationId}/workspace?path=${encodeURIComponent(path)}`
    : `/api/conversations/${conversationId}/workspace`
  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '加载失败' }))
    throw new Error(err.error || '加载失败')
  }
  const data = await res.json()
  return data.entries as WorkspaceEntry[]
}

/** 从 API 加载文件内容 */
async function fetchFile(conversationId: string, path: string): Promise<WorkspaceFileContent> {
  const res = await fetch(`/api/conversations/${conversationId}/workspace/file?path=${encodeURIComponent(path)}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '加载失败' }))
    throw new Error(err.error || '加载失败')
  }
  return res.json()
}

// ── 树节点组件 ──────────────────────────────────────────────────────────────

interface TreeNodeProps {
  entry: WorkspaceEntry
  depth: number
  conversationId: string
  expandedSet: Set<string>
  dirCache: Map<string, WorkspaceEntry[]>
  onToggleDir: (path: string) => void
  onSelectFile: (entry: WorkspaceEntry) => void
  selectedPath: string | null
  loadingPath: string | null
}

/** 文件夹节点：点击展开/收起，懒加载子目录 */
function TreeFolderNode({
  entry, depth, conversationId, expandedSet, dirCache, onToggleDir, onSelectFile, selectedPath, loadingPath,
}: TreeNodeProps) {
  const isExpanded = expandedSet.has(entry.path)
  const children = dirCache.get(entry.path)
  const isLoading = loadingPath === entry.path

  return (
    <div>
      <button
        data-testid={`folder-${entry.path}`}
        onClick={() => onToggleDir(entry.path)}
        className="w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-left hover:bg-white/30 text-stone-600 transition"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <ChevronRight
          className={`w-3.5 h-3.5 text-stone-400 shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
        />
        {isExpanded
          ? <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
          : <Folder className="w-4 h-4 text-amber-500 shrink-0" />
        }
        <span className="text-xs truncate flex-1">{entry.name}</span>
        {isLoading && <Loader2 className="w-3 h-3 animate-spin text-stone-400 shrink-0" />}
      </button>
      {isExpanded && children && children.length > 0 && (
        <div data-testid={`folder-children-${entry.path}`}>
          {sortEntries(children).map(child => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              conversationId={conversationId}
              expandedSet={expandedSet}
              dirCache={dirCache}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
              loadingPath={loadingPath}
            />
          ))}
        </div>
      )}
      {isExpanded && children && children.length === 0 && (
        <div
          className="text-[11px] text-stone-400 px-2 py-1"
          style={{ paddingLeft: `${(depth + 1) * 12 + 8 + 20}px` }}
        >
          空目录
        </div>
      )}
    </div>
  )
}

/** 文件节点 */
function TreeFileNode({
  entry, depth, selectedPath, onSelectFile,
}: {
  entry: WorkspaceEntry
  depth: number
  selectedPath: string | null
  onSelectFile: (entry: WorkspaceEntry) => void
}) {
  const isSelected = selectedPath === entry.path
  return (
    <button
      data-testid={`file-${entry.path}`}
      onClick={() => onSelectFile(entry)}
      className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-lg text-left transition ${
        isSelected ? 'bg-otter-400/15 text-otter-600' : 'hover:bg-white/30 text-stone-600'
      }`}
      style={{ paddingLeft: `${depth * 12 + 8 + 16}px` }}
    >
      <FileText className={`w-4 h-4 shrink-0 ${fileColor(entry.name)}`} />
      <span className="text-xs truncate flex-1">{entry.name}</span>
    </button>
  )
}

/** 通用树节点路由 */
function TreeNode(props: TreeNodeProps) {
  if (props.entry.isDirectory) {
    return <TreeFolderNode {...props} />
  }
  return (
    <TreeFileNode
      entry={props.entry}
      depth={props.depth}
      selectedPath={props.selectedPath}
      onSelectFile={props.onSelectFile}
    />
  )
}

// ── 文件内容渲染 ────────────────────────────────────────────────────────────

const MD_PLUGINS = [[remarkGfm, { singleTilde: false }] as const]

/** .md / .markdown → ReactMarkdown（GFM） */
function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose prose-xs max-w-none text-stone-700
      [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1.5
      [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:mt-2.5 [&_h2]:mb-1
      [&_h3]:text-xs [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-0.5
      [&_p]:text-xs [&_p]:leading-relaxed [&_p]:my-1
      [&_ul]:text-xs [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1
      [&_ol]:text-xs [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1
      [&_li]:my-0.5
      [&_code]:text-[11px] [&_code]:bg-white/50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded
      [&_pre]:bg-white/30 [&_pre]:rounded-lg [&_pre]:p-2 [&_pre]:overflow-x-auto
      [&_pre_code]:bg-transparent [&_pre_code]:p-0
      [&_blockquote]:border-l-2 [&_blockquote]:border-otter-300 [&_blockquote]:pl-3 [&_blockquote]:my-1 [&_blockquote]:text-stone-500
      [&_a]:text-otter-500 [&_a]:underline [&_a]:underline-offset-2
      [&_hr]:border-white/30 [&_hr]:my-2
      [&_table]:text-xs [&_table]:border-collapse
      [&_th]:border [&_th]:border-white/30 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-white/20
      [&_td]:border [&_td]:border-white/30 [&_td]:px-2 [&_td]:py-1
      [&_img]:max-w-full [&_img]:rounded-lg
    ">
      <ReactMarkdown remarkPlugins={MD_PLUGINS as never}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

/** .html / .htm → sandbox iframe */
function HtmlRenderer({ content }: { content: string }) {
  return (
    <iframe
      data-testid="html-sandbox"
      sandbox=""
      srcDoc={content}
      className="w-full rounded-lg border border-white/20 bg-white"
      style={{ minHeight: '200px', maxHeight: '400px' }}
      title="HTML 预览"
    />
  )
}

/** 其他 → 等宽 pre */
function PlainRenderer({ content }: { content: string }) {
  return (
    <pre className="text-xs text-stone-700 bg-white/30 rounded-lg p-2 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all font-mono">
      {content}
    </pre>
  )
}

/** 按扩展名分发渲染器 */
function FileContentViewer({ file }: { file: WorkspaceFileContent }) {
  const ext = getExt(file.path)
  const isMd = ext === 'md' || ext === 'markdown'
  const isHtml = ext === 'html' || ext === 'htm'

  return (
    <div className="p-3 border-t border-white/20">
      <div className="flex items-center gap-2 mb-2">
        <FileText className={`w-4 h-4 ${fileColor(file.path)}`} />
        <span className="text-xs font-semibold text-stone-600 truncate flex-1">
          {file.path.split('/').pop()}
        </span>
        <span className="text-[10px] text-stone-400">{file.path}</span>
        {file.truncated && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 shrink-0">
            已截断
          </span>
        )}
      </div>
      {isMd ? (
        <MarkdownRenderer content={file.content} />
      ) : isHtml ? (
        <HtmlRenderer content={file.content} />
      ) : (
        <PlainRenderer content={file.content} />
      )}
    </div>
  )
}

// ── 主面板 ──────────────────────────────────────────────────────────────────

export function WorkspacePanel({ conversationId }: WorkspacePanelProps) {
  const [rootEntries, setRootEntries] = useState<WorkspaceEntry[]>([])
  /** 已展开目录的缓存：path → children */
  const [dirCache, setDirCache] = useState<Map<string, WorkspaceEntry[]>>(new Map())
  /** 已展开的目录 path 集合 */
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set())
  /** 当前选中的文件内容 */
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent | null>(null)
  /** 正在加载的目录 path（用于显示 spinner） */
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  /** 正在加载文件 */
  const [loadingFile, setLoadingFile] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 加载根目录（仅初次） */
  useEffect(() => {
    let cancelled = false
    setLoadingPath('__root__')
    fetchDir(conversationId)
      .then(entries => { if (!cancelled) { setRootEntries(entries); setDirCache(prev => new Map(prev).set('', entries)) } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : '加载失败') })
      .finally(() => { if (!cancelled) setLoadingPath(null) })
    return () => { cancelled = true }
  }, [conversationId])

  /** 切换目录展开/收起 */
  const handleToggleDir = useCallback(async (path: string) => {
    setExpandedSet(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })

    // 首次展开：懒加载
    if (!dirCache.has(path)) {
      setLoadingPath(path)
      setError(null)
      try {
        const children = await fetchDir(conversationId, path)
        setDirCache(prev => new Map(prev).set(path, children))
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        setLoadingPath(null)
      }
    }
  }, [conversationId, dirCache])

  /** 选中文件 */
  const handleSelectFile = useCallback(async (entry: WorkspaceEntry) => {
    if (!entry.isFile) return
    setLoadingFile(true)
    setError(null)
    try {
      const data = await fetchFile(conversationId, entry.path)
      setSelectedFile(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
      setSelectedFile(null)
    } finally {
      setLoadingFile(false)
    }
  }, [conversationId])

  const sortedRoot = useMemo(() => sortEntries(rootEntries), [rootEntries])
  const selectedPath = selectedFile?.path ?? null

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-2 p-2 border-b border-white/20">
        <Folder className="w-4 h-4 text-stone-400" />
        <span className="text-xs font-semibold text-stone-500">工作区</span>
      </div>

      {/* 树 + 文件预览 */}
      <div className="flex-1 overflow-y-auto">
        {loadingPath === '__root__' && (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="w-4 h-4 animate-spin text-stone-400" />
          </div>
        )}

        {error && (
          <div className="p-3 text-xs text-red-500 bg-red-50 rounded-lg m-2">
            {error}
          </div>
        )}

        {loadingPath !== '__root__' && !error && sortedRoot.length === 0 && (
          <div className="p-4 text-xs text-stone-400 text-center">空目录</div>
        )}

        {loadingPath !== '__root__' && sortedRoot.length > 0 && (
          <div className="p-1" data-testid="workspace-tree">
            {sortedRoot.map(entry => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                conversationId={conversationId}
                expandedSet={expandedSet}
                dirCache={dirCache}
                onToggleDir={handleToggleDir}
                onSelectFile={handleSelectFile}
                selectedPath={selectedPath}
                loadingPath={loadingPath}
              />
            ))}
          </div>
        )}

        {/* 文件加载中 */}
        {loadingFile && (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="w-4 h-4 animate-spin text-stone-400" />
          </div>
        )}

        {/* 文件内容预览 */}
        {selectedFile && !loadingFile && (
          <FileContentViewer file={selectedFile} />
        )}
      </div>
    </div>
  )
}
