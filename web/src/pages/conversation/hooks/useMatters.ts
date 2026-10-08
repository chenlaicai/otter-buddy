import { useState, useEffect, useRef, useCallback } from 'react'
import type { MatterDTO } from '../../../api/client'
import * as api from '../../../api/client'
import { showToast } from '../../../components/Toast'

/**
 * F20261006mtlp P1：待办板数据 hook（只读）。
 * 数据源 = GET /api/conversations/:id/matters（matters 表 open 清单）。
 * 轮询 30s（与 useScheduledTasks 同节奏——板上钉住的事项不需要秒级刷新，
 * 裁决动作走对话直复，獭代迁移后下轮轮询自然反映）。
 *
 * F20261006mlp2 P2：板上按钮裁决动作（act）+ 「+」登记（register）。
 * 架构 = 回执代执行（通道 B，特性文档「按钮挂点架构定案」）：
 * 按钮不新增 HTTP 写端点，而是把搭档意图结构化成一条 html-matter-action
 * 回执消息，经 onRouteToOtter(ownerOtterId) 复用 sendMessage SSE 管线发给
 * owner 獭——由其 transition_matter(on_behalf_of='partner') 代执行迁移。
 * owner 已解散时后端 resolveSendTargets 自动退派在场大獭兜底，按钮仍可用。
 */

/** 板上裁决动作（按钮 → 目标态；to 由按钮声明、獭代执行透传——不让獭自由判映射） */
export type MatterAction = 'approve' | 'reject' | 'sendback' | 'confirm_close' | 'confirm_sendback' | 'reopen'

/** 动作 → 目标态（§2 矩阵的 partner 专属迁移行） */
const ACTION_TO_STATE: Record<MatterAction, string> = {
  /** WAITING_PARTNER → DONE_PENDING_CONFIRM（批准，獭按裁决执行后转待确认） */
  approve: 'DONE_PENDING_CONFIRM',
  /** WAITING_PARTNER → ABANDONED（否决 = 明确不做） */
  reject: 'ABANDONED',
  /** WAITING_PARTNER → WAITING_OTTER（打回/再改） */
  sendback: 'WAITING_OTTER',
  /** DONE_PENDING_CONFIRM → CLOSED（确认闭环） */
  confirm_close: 'CLOSED',
  /** DONE_PENDING_CONFIRM → WAITING_OTTER（闭环打回） */
  confirm_sendback: 'WAITING_OTTER',
  /** CLOSED → OPEN（翻案） */
  reopen: 'OPEN',
}

/** 各动作的人可读搭档意图（回执正文 + resolution 留痕原文） */
const ACTION_LABEL: Record<MatterAction, string> = {
  approve: '批准',
  reject: '否决（不做了）',
  sendback: '打回再改',
  confirm_close: '确认闭环',
  confirm_sendback: '打回续办',
  reopen: '翻案重开',
}

/** 构造板上裁决回执 body（人可读 + html-matter-action 围栏——獭解析 matter/to/on_behalf_of） */
export function buildMatterActionBody(matter: MatterDTO, action: MatterAction): string {
  const to = ACTION_TO_STATE[action]
  const label = ACTION_LABEL[action]
  const anchor = `M-${matter.id.slice(0, 8)}`
  return (
    `【待办·板上${label}】${anchor}「${matter.title}」—— 请代我执行板上迁移：${matter.state} → ${to}。\n\n` +
    `\`\`\`html-matter-action matter="${anchor}" to="${to}" on_behalf_of="partner"\n` +
    `{"matter":"${matter.id}","to":"${to}","on_behalf_of":"partner","partner_intent":"${label}"}\n` +
    `\`\`\``
  )
}

/** 「+」登记回执 body（准入路径 2——搭档手动登记 initialState=OPEN，由被唤醒獭调 RegisterMatter） */
export function buildMatterRegisterBody(title: string): string {
  return (
    `【待办·登记一件事】${title} —— 请登记到本对话待办板（initialState=OPEN，准入路径 2：搭档手动登记）。\n\n` +
    `\`\`\`html-matter-action register="true" initial_state="OPEN"\n` +
    `{"title":"${title.replace(/"/g, "'")}","initial_state":"OPEN","origin":"partner-manual"}\n` +
    `\`\`\``
  )
}

export interface UseMattersResult {
  matters: MatterDTO[]
  loading: boolean
  /** 近期闭环（closed 清单——折叠「近期闭环」区 = 翻案入口，P2）；created_at DESC 前 N 条 */
  recentClosed: MatterDTO[]
  /** 正在发送回执的 matter id（按钮 pending/防重——建议1，一个 matter 同时只发一条裁决） */
  pending: Record<string, boolean>
  /** 板上裁决（通道 B）：合成回执路由 owner 獭代执行；失败 toast 分流（#1268 教训） */
  act: (matter: MatterDTO, action: MatterAction) => Promise<void>
  /** 板上「+」登记（准入路径 2）：合成回执路由默认派发（在场獭/大獭）登记 */
  register: (title: string) => Promise<void>
}

/** 近期闭环区条数上限（折叠区低频操作，不铺满面板） */
const RECENT_CLOSED_LIMIT = 10

export function useMatters(
  conversationId: string | null,
  /** P2：回执路由通道（handleSend 的 mention 路由封装；owner 为空时传 undefined = 默认派发） */
  onRouteToOtter?: (body: string, ownerOtterId: string | null) => void,
): UseMattersResult {
  const [matters, setMatters] = useState<MatterDTO[]>([])
  const [recentClosed, setRecentClosed] = useState<MatterDTO[]>([])
  const [loading, setLoading] = useState(false)
  /** 正在发送回执的 matter id（pending/防重——建议1） */
  const [pending, setPending] = useState<Record<string, boolean>>({})
  /** ref 穿透：act/register 在回调闭包里读最新路由函数（不重建回调） */
  const routeRef = useRef(onRouteToOtter)
  routeRef.current = onRouteToOtter

  const fetchAll = useCallback(() => {
    if (!conversationId) return
    setLoading(true)
    // open 清单（主区）+ 含终态（近期闭环区）——同端点两次查询，面板薄可接受
    Promise.all([
      api.listMatters(conversationId),
      api.listMatters(conversationId, { includeClosed: true }),
    ])
      .then(([open, all]) => {
        setMatters(open)
        // 近期闭环区 = 终态翻案入口：CLOSED（翻案）+ ABANDONED（推翻「不做」恢复，F20261006mlp2 严重2/#1321）
        setRecentClosed(
          all.filter(m => ['CLOSED', 'SUPERSEDED', 'ABANDONED'].includes(m.state))
            .slice(0, RECENT_CLOSED_LIMIT),
        )
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [conversationId])

  useEffect(() => { fetchAll() }, [fetchAll])

  useEffect(() => {
    if (!conversationId) return
    const timer = setInterval(fetchAll, 30_000)
    return () => clearInterval(timer)
  }, [conversationId, fetchAll])

  /**
   * P2 板上裁决（通道 B 回执代执行）。
   *
   * 架构纪律（F20261006mlp2「按钮挂点架构定案」）：按钮不乐观改状态——状态真相只在
   * matters 表，迁移由 owner 獭收到回执后 transition_matter 代执行，板上提前渲染一个
   * 还没发生的迁移 = 双写分裂（板上说已迁、表里还没迁）。这里只合成回执发出去，
   * 真实状态变化经 30s 轮询反映（P1 同款节奏）。
   *
   * 失败处理（#1268/F20261006s1x0 教训——失败分支不许静默）：回执路由函数抛错时
   * toast 报错让搭档可重试；发送成功也只表「搭档已表达意图」，不表「已迁移」。
   *
   * F20261006mlp2 P2 处置建议1：act 改 async、接路由真实结果再 toast——此前先弹成功
   * toast 再 fire-and-forget 发回执，发送失败时搭档已看到成功假象。现在 await 路由：
   * resolve 才弹「已发送请求」，reject 弹「发送失败」。按钮防重由 disabled 态兜（MattersPanel）。
   */
  const act = useCallback(async (matter: MatterDTO, action: MatterAction): Promise<void> => {
    const anchor = `M-${matter.id.slice(0, 8)}`
    // 防重：同一 matter 已有回执在飞则忽略（建议1——防双击/重入并发发两条裁决）
    if (pending[matter.id]) return
    setPending(p => ({ ...p, [matter.id]: true }))
    try {
      const body = buildMatterActionBody(matter, action)
      if (!routeRef.current) {
        showToast(`「${anchor}」${ACTION_LABEL[action]}失败：路由通道不可用，请重试`, 'error')
        return
      }
      await routeRef.current(body, matter.ownerOtterId)
      showToast(`已把「${anchor}」${ACTION_LABEL[action]}的请求发给负责獭，迁移完成后板上更新`, 'info')
    } catch {
      showToast(`「${anchor}」${ACTION_LABEL[action]}回执发送失败，请重试`, 'error')
    } finally {
      setPending(p => { const n = { ...p }; delete n[matter.id]; return n })
    }
  }, [pending])

  /** P2 「+」登记（准入路径 2）：合成登记回执走默认派发（无显式 owner——登记无需 owner）
   *  F20261006mlp2 P2 处置严重1：回执让獭用 register_matter 工具登记（工具已补）；
   *  act/register 均 async 接真实发送结果再 toast（此前先弹成功=假象，#1268 同向）。 */
  const register = useCallback(async (title: string): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      const body = buildMatterRegisterBody(trimmed)
      if (!routeRef.current) {
        showToast('登记失败：路由通道不可用', 'error')
        return
      }
      await routeRef.current(body, null)
      showToast('已把登记请求发给在场獭', 'info')
    } catch {
      showToast('登记失败，请重试', 'error')
    }
  }, [])

  return { matters, loading, recentClosed, pending, act, register }
}
