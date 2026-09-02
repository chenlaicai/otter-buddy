import type { LocalMessage } from './mappers'

/**
 * F20260901sgpx §7：「一轮」= 信号触发→静默 的活动段分组——UI 从消息流派生的视图，
 * 非数据库实体（turn 表退役后本函数是唯一分组真相源，读路径先行）。
 *
 * v1 启发式（P1 信号落地前的过渡实现）：
 * - user 消息开新段（用户发起交互 ≈ 新一轮，与 ensureActiveTurn 语义对齐——
 *   链跑完 tryCloseTurn 后用户消息必开新 turn，send-message.ts:643）
 * - 相邻消息时间间隔超过 ACTIVITY_GAP_MS 开新段（长静默 = 上轮已收束）
 * - otter/system 消息不切段（跟随当前活动）
 * P1 信号落地后升级为按投递信号触发切分（signal_level 非空的消息即段边界）。
 *
 * 设计决策：本分组**替代** MessageList 原按 turnId 的分隔线（isNewTurn）——
 * P4 拆 turn 写路径时 UI 零改动，这正是「先立后拆」的读路径先行。
 */
export interface ActivityGroup {
  /** 组 id = 首消息 id（React key 用） */
  id: string
  messages: LocalMessage[]
  /** 首消息时间（ISO） */
  startedAt: string
  /** 切分依据（可解释性，调试/测试断言用） */
  reason: 'conversation-start' | 'user-message' | 'gap'
}

/** 活动段切分间隔：相邻消息静默超过此时长视为新一轮（毫秒） */
export const ACTIVITY_GAP_MS = 5 * 60 * 1000

/**
 * 将消息流切分为活动段。输入按时序排列（渲染层 messages 数组本就时序有序，
 * 含无 seq 的乐观消息——分组只依赖 ts，不依赖 seq/turnId）。
 */
export function groupByActivity(messages: LocalMessage[]): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  let current: ActivityGroup | null = null
  let prevTs = 0

  for (const m of messages) {
    const ts = Date.parse(m.ts)
    let reason: ActivityGroup['reason'] | null = null
    if (!current) {
      reason = 'conversation-start'
    } else if (m.st === 'user') {
      reason = 'user-message'
    } else if (Number.isFinite(ts) && ts - prevTs > ACTIVITY_GAP_MS) {
      reason = 'gap'
    }

    if (reason || !current) {
      current = { id: m.id, messages: [m], startedAt: m.ts, reason: reason ?? 'conversation-start' }
      groups.push(current)
    } else {
      current.messages.push(m)
    }
    // 无效 ts 不参与间隔计算（乐观消息 ts 恒有效，防御性处理）
    if (Number.isFinite(ts)) prevTs = ts
  }
  return groups
}
