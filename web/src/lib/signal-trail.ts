import type { LocalMessage } from './mappers'

/**
 * 信号轨迹 · 用户视角状态盒（F20260902u5tr，母方案 F20260901sgpx §7）。
 *
 * 三态全部由服务端 SignalTrailItemDTO.state 承载（服务端从游标/streaming 持久层推导），
 * 本模块只做「信号识别 + 展示态映射 + 措辞约束」——前端零状态推导（持久层真相前端不可达）。
 *
 * 措辞约束（flash 提案缺口 3）：busy 判定是近似（isOtterActive 5min 窗口），
 * 面向用户只说「排队待消化」，不说「ta 正在忙」/「第几位」——队列位置是内存态，
 * 重启会说谎（#695 大獭裁决 ②）。
 */

/** 服务端轨迹条目（SignalTrailItemDTO 投影） */
export interface TrailItem {
  messageId: string
  fromType: 'user' | 'otter'
  fromId: string
  targetOtterId: string
  level: string
  state: 'PENDING' | 'CONSUMING' | 'CONSUMED'
  ts: string
  seq: number
}

/**
 * 消息级信号判据（与后端 QuerySignalTrail / SignalRouter.queryCandidateSignals 对齐）：
 * completed + 非 system + talkingStonePassedTo 含至少一个 otter 目标。
 * 用户消息的 tsp 已由后端 DTO 携带（tsp 字段），乐观消息（无 tsp）不判信号。
 */
export function isSignalMessage(m: LocalMessage): boolean {
  return m.status === 'completed'
    && m.st !== 'system'
    && (m.tsp ?? []).some(t => t !== 'user')
}

/** 状态盒三态 → 用户可见徽标（文案 + 样式类）。措辞约束固化在此。 */
export function trailStateMeta(state: TrailItem['state'], level: string): { icon: string; label: string; cls: string; title: string } {
  if (state === 'CONSUMED') {
    return { icon: '✓', label: '已处理', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', title: `信号已被目标消化（${level}）` }
  }
  if (state === 'CONSUMING') {
    return { icon: '⚡', label: '处理中', cls: 'bg-teal-50 text-teal-700 border-teal-200', title: `目标正在消化该信号（${level}）` }
  }
  // PENDING：排队待消化——不说「正在忙」（busy 判定是近似）、不说「第几位」（内存态会说谎）
  const urgent = level === 'URGENT' || level === 'HALT'
  return {
    icon: '⏳',
    label: '排队待消化',
    cls: urgent ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200',
    title: `信号已投递、待目标消化（${level}）`,
  }
}

/** 档位徽标（谁→谁的轨迹行内展示） */
export function trailLevelMeta(level: string): { label: string; cls: string } {
  switch (level) {
    case 'URGENT': return { label: 'URGENT', cls: 'bg-red-100 text-red-700' }
    case 'HALT': return { label: 'HALT', cls: 'bg-red-600 text-white' }
    default: return { label: 'NORMAL', cls: 'bg-stone-100 text-stone-500' }
  }
}
