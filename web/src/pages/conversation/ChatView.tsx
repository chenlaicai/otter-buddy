import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Archive, ShieldAlert, Activity, GripHorizontal } from 'lucide-react'
import type { LocalConversation as Conversation, LocalOtter as Otter, LocalMessage as Message, LocalLinkedResource as LinkedResource } from '../../lib/mappers'
import type { CardPreview } from './hooks/useCardBridge'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { useAttachmentStaging, type StagedAttachment } from './hooks/useAttachmentStaging'

interface ChatViewProps {
  conversation: Conversation | null
  messages: Message[]
  state: 'normal' | 'empty' | 'loading' | 'error' | 'no-llm'
  onSend: (text: string, mentionOtterIds?: string[], attachments?: StagedAttachment[], mode?: 'steer' | 'followUp') => void | Promise<void>
  onStopStream: (messageId: string) => void
  onRetryMessage: (messageId: string) => void
  onRetry: () => void
  onGoToSettings: () => void
  onArchive: () => void
  otters: Otter[]
  // 滚动 props 透传
  conversationId: string
  pinRef: RefObject<boolean>
  newMessagesCount?: number
  onJumpToBottom?: () => void
  onLoadMore?: () => void
  loadingMore?: boolean
  unreadSeparatorSeq?: number | null
  highlightMessageId?: string | null
  /** 用户在设置中配置的称呼 */
  userName?: string
  /** F20261008csf1 P1：文类产物摘要卡数据源 */
  linkedResources?: LinkedResource[]
  /** F20261013csv3 T5：过程明细开关（内存态——刷新回默认关闭） */
  showProcessDetail?: boolean
  onToggleProcessDetail?: () => void
  /** 卡片提交待确认预览（输入框上方单槽位） */
  cardPreview?: CardPreview | null
  onConfirmCard?: () => void
  onRejectCard?: () => void
}

/** F20261016inbs：输入框固定边界分割条常量。搭档拍板（微信式）：消息框与输入框之间隔离
 *  边界固定、两框各自滚动、输入内容不改变边界，用户可手动拖动分割条改变上下两框大小。
 *  localStorage 持久化——下次进入恢复；clamp 下限保单行可用，上限防输入框吃掉整个聊天区 */
const INPUT_SPLIT_KEY = 'otter.chat.inputHeight'
const INPUT_HEIGHT_DEFAULT = 120
const INPUT_HEIGHT_MIN = 64
/** 上限取容器高的 55%——不是常量而是容器实高的比例（拖动时实时 clamp） */
function inputHeightMax(overlayEl: HTMLElement): number {
  const containerH = overlayEl.parentElement?.clientHeight ?? 0
  // 未测量（clientHeight=0，如 jsdom）时不设上限——clamp 只在有真实容器尺寸时才有意义；
  // 否则会把持久化的合理高度误吞到回退档（真实浏览器 mount 后 clientHeight 恒 >0）
  return containerH > 0 ? Math.floor(containerH * 0.55) : Infinity
}
function clampInputHeight(px: number, overlayEl: HTMLElement): number {
  return Math.min(Math.max(px, INPUT_HEIGHT_MIN), inputHeightMax(overlayEl))
}
/** 读持久化高度，异常值（缺失/NaN/越界）回退默认——存储可能被外部篡改或来自旧版本 */
function loadInputHeight(overlayEl: HTMLElement): number {
  const rawStr = localStorage.getItem(INPUT_SPLIT_KEY)
  if (rawStr == null) return INPUT_HEIGHT_DEFAULT
  const raw = Number(rawStr)
  // 注意：Number(null)===0 非 NaN——getItem 缺失时已提前返回，这里只需拦真 NaN（'abc' 等）
  if (!Number.isFinite(raw)) return INPUT_HEIGHT_DEFAULT
  return clampInputHeight(raw, overlayEl)
}

export function ChatView(props: ChatViewProps) {
  const { conversation: c } = props
  const staging = useAttachmentStaging(props.conversationId || null)
  /** F20261016inbs：输入覆盖层容器 ref——ResizeObserver 观测目标（实高含分割条+附件行+玻璃框+
   *  底部提示行），实高变化时同步 bottomSpacerPx 给 MessageList 做等高衬垫。首帧 mount 前
   *  为 null（0px 兜底），mount 后立即触发（无内容时玻璃框实高 = inputHeight，衬垫即就位） */
  const overlayRef = useRef<HTMLDivElement>(null)
  /** 分割条拖动中的输入框高度——与输入内容无关（固定边界拍板），仅拖动/恢复时变化 */
  const [inputHeight, setInputHeight] = useState(INPUT_HEIGHT_DEFAULT)
  const [bottomSpacerPx, setBottomSpacerPx] = useState(0)

  /** mount/首帧：恢复持久化高度（需 overlay 已挂载才能 clamp 容器比例上限） */
  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    setInputHeight(loadInputHeight(overlay))
  }, [])

  /** overlay 实高 → bottomSpacerPx：动态衬垫的单一数据源。依赖 [inputHeight] 重跑无妨
   *  （ResizeObserver.observe 同一目标幂等）；RO 回调在内容真实变化时同步，不依赖 deps */
  useEffect(() => {
    const overlay = overlayRef.current
    if (typeof ResizeObserver === 'undefined' || !overlay) return
    const ro = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      const h = entry?.contentRect?.height ?? 0
      setBottomSpacerPx(Math.round(h))
    })
    ro.observe(overlay)
    return () => ro.disconnect()
  }, [inputHeight])

  /** 分割条拖动：pointerdown 捕获起点 → window 级 pointermove（拖出分割条热区仍跟踪，
   *  setPointerCapture 在 iframe/边界场景不可靠，window 监听 + pointerup 兜底更稳）→
   *  pointerup/pointercancel 持久化。拖动只写 inputHeight（玻璃框固定高），overlay 实高随之
   *  变化，衬垫经 RO 链同步。
   *  R2 竞态修复（检视獭发现）：onUp 不得读 inputHeightRef（useEffect 镜像在 move 与 up
   *  同一 React batch 内未 flush，读到拖动前旧值——同帧松手持久化陈旧高度，CI flake 的
   *  「拖到 160 存 120/152」即此）：改为闭包内局部 latest 变量，move 同步写入，零 React
   *  时序依赖。pointercancel（触屏被电话/手势打断）与 up 同路径：按当前最新高度收尾，
   *  高度不随悬空指针漂移。 */
  const inputHeightRef = useRef(inputHeight)
  useEffect(() => { inputHeightRef.current = inputHeight }, [inputHeight])
  const handleSplitterPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const overlay = overlayRef.current
    if (!overlay) return
    const startY = e.clientY
    const startHeight = inputHeightRef.current
    let latestHeight = startHeight
    const maxHeight = inputHeightMax(overlay)
    const onMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY
      latestHeight = Math.min(Math.max(startHeight + delta, INPUT_HEIGHT_MIN), maxHeight)
      setInputHeight(latestHeight)
    }
    const onFinish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onFinish)
      window.removeEventListener('pointercancel', onFinish)
      // 松手持久化：下次进入恢复。读闭包局部 latest（同帧 up 时 useEffect 镜像未 flush）
      localStorage.setItem(INPUT_SPLIT_KEY, String(latestHeight))
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onFinish, { passive: true })
    window.addEventListener('pointercancel', onFinish, { passive: true })
  }, [])

  /** F20260916sgcl：发送成功后清空中转区——此前 MessageInput 直接透传 staged 给 onSend，
   *  没有任何环节调 clearAll/takeForSend，导致悬浮附件发送后不消失、下一条消息还会重复携带。
   *  await 到 Promise 落定再 clearAll（S1 修复）：失败路径（sendMessage reject）不清空，
   *  附件保留在中转区供重试；错误 toast 由 index.tsx handleSend 内部统一出，这里不重复。 */
  async function handleSendWithStaging(text: string, mentionOtterIds?: string[], attachments?: StagedAttachment[], mode?: 'steer' | 'followUp') {
    try {
      await props.onSend(text, mentionOtterIds, attachments, mode)
      staging.clearAll()
    } catch {
      // 发送失败：附件保留在中转区供重试（toast 已在 handleSend 内部出过）
    }
  }

  return (
    // F20261016inbs R1：relative 显式锚定输入覆盖层（absolute bottom-0）的 containing block。
    // 背景：dev 下 .glass 的标准 backdrop-filter（建 CB）锚 main 内盒；build 压缩丢弃标准
    // 属性只留 -webkit-（不建 CB）→ 覆盖层漂到外层 wrapper 底、探出 main 13px、死区 38px
    // （CI 实测，检视獭发现；本地 dev 25px 绿是环境差异掩盖的断言失实）。relative 使两
    // 环境一致锚 main，不依赖 backdrop-filter 副作用。
    <main className="relative flex-1 glass rounded-3xl flex flex-col overflow-hidden">
      {/* Chat Header */}
      <div className="px-1 py-3 flex items-center justify-between border-b border-white/40 flex-shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-stone-700">{c?.title || '对话'}</h1>
          {c && (
            <span
              className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                c.status === 'active'
                  ? 'bg-teal-400/15 text-teal-500'
                  : 'bg-stone-400/15 text-stone-400'
              }`}
            >
              {/* F20260922cgrp：弱状态两态——completed 退役，只剩 活跃 | 已归档 */}
              {c.status === 'active' ? '活跃' : '已归档'}
            </span>
          )}
        </div>
        {c && (
          <div className="flex gap-1.5">
            {/* F20261013csv3 T5：过程明细开关——内存态，刷新回默认关闭 */}
            {props.onToggleProcessDetail && (
              <button
                onClick={props.onToggleProcessDetail}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg transition flex items-center gap-1 ${
                  props.showProcessDetail
                    ? 'bg-otter-400/20 text-otter-600'
                    : 'glass-card text-stone-600 hover:bg-white/50'
                }`}
                title="显示工具调用过程明细（刷新后恢复默认关闭）"
              >
                <Activity className="w-3 h-3" />
                {props.showProcessDetail ? '过程明细 · 开' : '过程明细'}
              </button>
            )}
            <button
              onClick={props.onArchive}
              disabled={c.status === 'archived'}
              className="px-2.5 py-1 text-xs font-medium rounded-lg glass-card text-stone-600 hover:bg-white/50 transition flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Archive className="w-3 h-3" /> 归档
            </button>
          </div>
        )}
      </div>

      {/* Message List */}
      <MessageList
        messages={props.messages}
        state={props.state}
        onStopStream={props.onStopStream}
        onRetryMessage={props.onRetryMessage}
        onRetry={props.onRetry}
        onGoToSettings={props.onGoToSettings}
        otters={props.otters}
        conversationId={props.conversationId}
        pinRef={props.pinRef}
        newMessagesCount={props.newMessagesCount}
        onJumpToBottom={props.onJumpToBottom}
        onLoadMore={props.onLoadMore}
        loadingMore={props.loadingMore}
        unreadSeparatorSeq={props.unreadSeparatorSeq}
        highlightMessageId={props.highlightMessageId}
        userName={props.userName}
        linkedResources={props.linkedResources}
        bottomSpacerPx={bottomSpacerPx}
      />

      {/* 卡片提交预览槽位（强制且永久，无直接发送开关）：summary 全文 + data JSON 全文默认可见 */}
      {props.cardPreview && (
        <div className="mx-1 mb-2 rounded-2xl border border-amber-200/60 bg-amber-50/60 px-4 py-3 flex-shrink-0">
          <div className="flex items-start gap-1.5 text-[11px] text-amber-700 mb-2">
            <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>以下内容由水獭卡片生成，请核对后发送；已提交的卡片不可重复提交，修改答案请让水獭重发新卡</span>
          </div>
          <div className="text-sm text-stone-700 whitespace-pre-wrap break-all mb-2">{props.cardPreview.summary}</div>
          {props.cardPreview.dataJson !== null && (
            <details open className="mb-2">
              <summary className="text-[11px] text-stone-500 cursor-pointer select-none">数据 JSON（全文）</summary>
              <pre className="mt-1 text-[11px] text-stone-500 bg-white/60 rounded-lg px-3 py-2 whitespace-pre-wrap break-all max-h-[var(--preview-scroll-max-h)] overflow-y-auto">{props.cardPreview.dataJson}</pre>
            </details>
          )}
          <div className="flex gap-2">
            <button
              onClick={props.onConfirmCard}
              className="px-3 py-1 text-xs font-medium text-white rounded-xl shadow-glow transition"
              style={{ background: 'linear-gradient(135deg,#A88260,#8B6F47)' }}
            >
              发送
            </button>
            <button
              onClick={props.onRejectCard}
              className="px-3 py-1 text-xs glass-card text-stone-500 rounded-xl transition hover:bg-white/50"
            >
              拒绝
            </button>
          </div>
        </div>
      )}

      {/* Input：F20261015inpd 覆盖层 + F20261016inbs 固定边界——absolute 悬浮底部，脱离
          文档流不挤压消息列表；顶部 8px 分割条热区（可拖），实高经 ResizeObserver 同步给
          MessageList 做等高衬垫（旧写死 170px 预留已删，死区归零） */}
      <div ref={overlayRef} className="absolute bottom-0 left-0 right-0 z-10">
        {/* 分割条热区：输入区顶沿，拖动改变固定高度（仅拖动可变——输入内容不改变边界） */}
        <div
          onPointerDown={handleSplitterPointerDown}
          className="group relative h-2 -mt-2 cursor-row-resize touch-none z-20"
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整输入框高度"
          title="拖动调整输入框高度"
        >
          {/* 视觉手柄：默认隐蔽，hover/拖动时显现 */}
          <span className="absolute inset-x-0 -top-0.5 bottom-1 flex items-start justify-center pointer-events-none">
            <GripHorizontal className="w-4 h-2 text-stone-300 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
          </span>
        </div>
        <MessageInput
          onSend={handleSendWithStaging}
          disabled={c?.status === 'archived'}
          otters={props.otters}
          conversationId={props.conversationId}
          inputHeight={inputHeight}
          staged={staging.staged}
          onRemoveAttachment={staging.remove}
          onPickFiles={staging.addFiles}
          uploadError={staging.uploadError}
          onDismissUploadError={() => staging.setUploadError(null)}
        />
      </div>
    </main>
  )
}
