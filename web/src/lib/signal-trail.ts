import type { LocalMessage } from './mappers'

/**
 * 信号轨迹 · 用户视角状态盒（F20260902u5tr → sgp2 S1b 判据切台账）。
 *
 * 四态全部由服务端 SignalTrailItemDTO.state 承载（服务端从 dispatch_attempts 台账持久层推导），
 * 本模块只做「信号识别 + 展示态映射 + 措辞约束」——前端零状态推导（持久层真相前端不可达）。
 *
 * 措辞约束（flash 提案缺口 3，#695 裁决固化）：
 * - PENDING 只说「排队待消化」，不说「正在忙」/「第几位」（内存态重启会说谎）
 * - FAILED 显失败原因（attempt.note），「用户决定是否 retry」（sgp2 取舍 #2）的 UI 面在此闭合
 */

/** 服务端轨迹条目（SignalTrailItemDTO 投影） */
export interface TrailItem {
  messageId: string
  fromType: 'user' | 'otter'
  fromId: string
  targetOtterId: string
  level: string
  state: 'PENDING' | 'CONSUMING' | 'CONSUMED' | 'FAILED'
  ts: string
  seq: number
  /** FAILED 态失败原因（attempt.note）；其余态 null */
  note?: string | null
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

/**
 * G7 黑话映射（S3.5 / F20260903s35u）：attempt.note 的内部语言 → 用户可读短语。
 * 映射表覆盖系统会写入的三类内部措辞；未命中时原样透出（排查线索不丢）。
 */
const NOTE_HUMAN_MAP: Array<[RegExp, string]> = [
  [/进程重启，派发中断[^(]*/g, '服务重启时被打断'],
  [/router catch:/g, '自动处理失败'],
  [/legacy-attempted[^;]*/g, '历史消息（升级台账前已处理）'],
]

/** note → 人话（截断到首层原因——§8.2 的 retry 前情链对用户是噪音，展开详情才看全） */
export function humanizeNote(note: string | null | undefined): string | null {
  if (!note) return null
  let out = note
  for (const [re, human] of NOTE_HUMAN_MAP) out = out.replace(re, human)
  // 首个分号前 = 本轮原因（prev= 链是历史轮次，详情展开再看）
  const first = out.split(';')[0].trim()
  return first || null
}

/**
 * 状态盒四态 → 用户可见徽标（文案 + 样式类，sgp2 §4.7 映射表）。措辞约束固化在此。
 *
 * S3.5 弱化模式（G8，搭档 A 方案裁决）：quiet=true 时正常流转态（PENDING/CONSUMING/
 * CONSUMED）只出图标不出文字（信息密度降噪，透明度给需要时用）；异常态（FAILED）
 * 与高优档（URGENT/HALT）保持醒目——「异常才显眼」。
 */
export function trailStateMeta(state: TrailItem['state'], level: string, note?: string | null, quiet?: boolean): { icon: string; label: string; cls: string; title: string } {
  const urgent = level === 'URGENT' || level === 'HALT'
  // quiet 弱化：label 缩为空串（仅图标），FAILED/urgent 豁免
  const quietLabel = (icon: string, full: string) => (quiet && !urgent ? icon : full)
  if (state === 'CONSUMED') {
    return { icon: '✓', label: quietLabel('✓', '已处理'), cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', title: `信号已被目标消化（${level}）` }
  }
  if (state === 'CONSUMING') {
    return { icon: '⚡', label: quietLabel('⚡', '处理中'), cls: 'bg-teal-50 text-teal-700 border-teal-200', title: `目标正在消化该信号（${level}）` }
  }
  if (state === 'FAILED') {
    // 失败首次可见（S1b 验收③）：❌ + 人话原因（G7 映射）。失败可见 → 用户才知道该手动 retry
    return { icon: '❌', label: quietLabel('❌', '处理失败'), cls: 'bg-rose-50 text-rose-700 border-rose-200', title: `处理失败（${level}）${humanizeNote(note) ? `：${humanizeNote(note)}` : ''}` }
  }
  // PENDING：排队待消化——不说「正在忙」（busy 判定是近似）、不说「第几位」（内存态会说谎）
  return {
    icon: '⏳',
    label: quietLabel('⏳', '排队待消化'),
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
