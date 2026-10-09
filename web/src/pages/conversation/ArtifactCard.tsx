import { useState } from 'react'
import { GitPullRequest, FileText, Lightbulb, Pin, PinOff, ExternalLink } from 'lucide-react'
import type { LocalLinkedResource } from '../../lib/mappers'

/** F20261008csf1 P1：文类产物摘要卡。
 *
 * 宪法定义：文类 = PR/F-R 文档/报告/fact，中间栏展示形态 = 摘要卡（diff 统计/首段摘要/结论
 * 数字），点击进全文。视觉与消息气泡强区分（边框+底色+类型徽章）——混排可扫读性的来源。
 *
 * 数据源口径（为何 PR 卡只有标题/URL/时间）：
 *  - linked_resources 表对 pr 类型只存 title+url+metadata（无 diff 统计列）——diff/CI 状态
 *    需要额外接 gh API，本期不做（宪法 P1 范围：数据现成）；卡片信息增量 = 类型徽章 + 标题 +
 *    登记人 + 时间 + 直达链接
 *  - file 类型同（title+url）；fact 类型有 content 本体（≤500 字），摘要卡直接显示全文
 *  - 点击行为：url 存在新窗口打开（「点击进详情」）；无 url 的 fact 展开全文（fact 全文
 *    ≤500 字，卡内直接展示，无需展开）
 */

/** 类型徽章配置：图标 + 底色 + 文案 */
const TYPE_BADGES: Record<string, { label: string; icon: typeof FileText; badgeClass: string }> = {
  pr: { label: 'PR', icon: GitPullRequest, badgeClass: 'bg-emerald-50 text-emerald-600 border-emerald-200/60' },
  file: { label: '文档', icon: FileText, badgeClass: 'bg-sky-50 text-sky-600 border-sky-200/60' },
  fact: { label: '事实', icon: Lightbulb, badgeClass: 'bg-amber-50 text-amber-600 border-amber-200/60' },
}

/** 摘要截断：file 类型卡片内最多显示的字数（首段摘要语义，不追求全文） */
const FILE_SNIPPET_MAX = 220

function fileSnippet(content: string): string {
  // 首段摘要：取第一个空行之前的文本（markdown 段落语义），超限截断
  const firstPara = content.split(/\n\s*\n/)[0] ?? ''
  const cleaned = firstPara.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= FILE_SNIPPET_MAX) return cleaned
  return cleaned.slice(0, FILE_SNIPPET_MAX) + '…'
}

export function ArtifactCard({ resource, pinned, onTogglePin }: {
  resource: LocalLinkedResource
  pinned: boolean
  onTogglePin: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const badge = TYPE_BADGES[resource.type] ?? {
    label: resource.type,
    icon: FileText,
    badgeClass: 'bg-stone-100 text-stone-500 border-stone-200/60',
  }
  const Icon = badge.icon

  const body = (() => {
    if (resource.type === 'fact') {
      // fact 全文 ≤500 字（FACT_CONTENT_MAX_LENGTH），卡内直出——这就是「结论卡」的信息增量
      return <p className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap break-words">{resource.content}</p>
    }
    if (resource.content) {
      return <p className="text-sm text-stone-600 leading-relaxed">{fileSnippet(resource.content)}</p>
    }
    if (resource.url) {
      return <p className="text-xs text-stone-400 truncate">{resource.url}</p>
    }
    return null
  })()

  return (
    <div
      data-artifact-id={resource.id}
      className={`my-2 rounded-xl border px-3.5 py-3 max-w-md transition ${
        pinned
          ? 'border-otter-300/60 bg-otter-50/50'
          : 'border-stone-200/80 bg-stone-50/70'
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${badge.badgeClass}`}>
          <Icon className="w-3 h-3" />
          {badge.label}
        </span>
        <span className="text-sm font-medium text-stone-700 truncate flex-1">{resource.title}</span>
        <button
          onClick={() => onTogglePin(resource.id)}
          className="p-1 rounded hover:bg-stone-200/70 transition text-stone-400 hover:text-stone-600 flex-shrink-0"
          title={pinned ? '取消钉住' : '钉住（留在视野中）'}
        >
          {pinned ? <Pin className="w-3.5 h-3.5 text-otter-500" /> : <PinOff className="w-3.5 h-3.5" />}
        </button>
      </div>
      {body}
      {expanded && resource.type !== 'fact' && resource.content && (
        <p className="mt-2 text-sm text-stone-600 leading-relaxed whitespace-pre-wrap break-words border-t border-stone-200/60 pt-2">
          {resource.content}
        </p>
      )}
      <div className="flex items-center gap-2.5 mt-2 text-[11px] text-stone-400">
        {resource.url && (
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-otter-500 hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            打开
          </a>
        )}
        {!expanded && resource.type !== 'fact' && resource.content && resource.content.length > FILE_SNIPPET_MAX && (
          <button
            onClick={() => setExpanded(true)}
            className="text-stone-400 hover:text-stone-600"
          >
            展开全文
          </button>
        )}
        {resource.auto && <span>自动登记</span>}
      </div>
    </div>
  )
}
