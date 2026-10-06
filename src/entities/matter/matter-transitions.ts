/**
 * Matter 状态机迁移矩阵（F20261006mtlp §2）。
 *
 * 合法迁移矩阵的唯一真相源：未列入矩阵的迁移一律非法，
 * TransitionMatter usecase 单入口据此拒绝（验证节锁定「非法迁移拒绝」）。
 *
 * 触发者语义（守卫判定的输入，不由本表强制执行——执行在 usecase 层）：
 * - 'partner'：搭档（板上按钮 P2 / 对话直复通道 A 的獭代执行须声明代执行）
 * - 'owner'：负责獭（owner_otter_id === 调用獭）
 * - 'any_otter'：任意獭（通道 A 代执行路径——迁移守卫兜住权限）
 */

import type { MatterState } from '@entities/matter/matter';

/** 迁移矩阵条目 */
export interface MatterTransition {
  from: MatterState;
  to: MatterState;
  /** 合法触发者集合 */
  allowed: readonly string[];
  /** 守卫/说明（方案 §2 矩阵「守卫/说明」列） */
  note: string;
}

/**
 * §2 合法迁移矩阵（14 条 + 创建 2 条 = 16 条）。
 * 索引 key = `${from}->${to}`，查询 O(1)。
 */
const TRANSITIONS: ReadonlyMap<string, MatterTransition> = new Map([
  // （创建）→ WAITING_PARTNER：准入路径 1——L2 yield to user 自动登记，生而待裁决
  ['__CREATE__->WAITING_PARTNER', {
    from: '__CREATE__' as unknown as MatterState,
    to: 'WAITING_PARTNER',
    allowed: ['system'],
    note: 'L2 显式拍板项 yield 打标 expects_partner_decision 自动登记',
  }],
  // （创建）→ OPEN：准入路径 2/3——「回头再说」/跨日未收尾任务登记
  ['__CREATE__->OPEN', {
    from: '__CREATE__' as unknown as MatterState,
    to: 'OPEN',
    allowed: ['partner', 'any_otter', 'system'],
    note: '「回头再说」/跨日未收尾任务登记，先 OPEN',
  }],
  // OPEN → WAITING_OTTER：负责獭认领
  ['OPEN->WAITING_OTTER', {
    from: 'OPEN', to: 'WAITING_OTTER',
    allowed: ['any_otter'],
    note: '登记 waiting_on=otter:<id> + waiting_for',
  }],
  // OPEN → WAITING_PARTNER：獭呈搭档拍板
  ['OPEN->WAITING_PARTNER', {
    from: 'OPEN', to: 'WAITING_PARTNER',
    allowed: ['any_otter'],
    note: '需呈搭档拍板/确认时（附 payload 简报）',
  }],
  // WAITING_OTTER → WAITING_PARTNER：负责獭干完需搭档裁决
  ['WAITING_OTTER->WAITING_PARTNER', {
    from: 'WAITING_OTTER', to: 'WAITING_PARTNER',
    allowed: ['owner'],
    note: '獭干完需搭档裁决',
  }],
  // WAITING_OTTER → DONE_PENDING_CONFIRM：负责獭宣称完成
  ['WAITING_OTTER->DONE_PENDING_CONFIRM', {
    from: 'WAITING_OTTER', to: 'DONE_PENDING_CONFIRM',
    allowed: ['owner'],
    note: '獭宣称完成（L1/L2），等闭环确认',
  }],
  // WAITING_PARTNER → DONE_PENDING_CONFIRM：搭档裁决（批准路径）
  ['WAITING_PARTNER->DONE_PENDING_CONFIRM', {
    from: 'WAITING_PARTNER', to: 'DONE_PENDING_CONFIRM',
    allowed: ['partner'],
    note: '裁决写入 resolution，獭按裁决执行后转待确认',
  }],
  // WAITING_PARTNER → WAITING_OTTER：搭档打回/再改
  ['WAITING_PARTNER->WAITING_OTTER', {
    from: 'WAITING_PARTNER', to: 'WAITING_OTTER',
    allowed: ['partner'],
    note: '裁决为「打回/再改」时',
  }],
  // DONE_PENDING_CONFIRM → CLOSED：见宣告权表——L1=獭自关；L2=必须搭档确认
  ['DONE_PENDING_CONFIRM->CLOSED', {
    from: 'DONE_PENDING_CONFIRM', to: 'CLOSED',
    allowed: ['owner', 'partner'],
    note: 'L1=獭自关留痕；L2=必须搭档确认（宣告权分权，守卫见 transition-matter）',
  }],
  // DONE_PENDING_CONFIRM → WAITING_OTTER：搭档打回（闭环确认不通过）
  ['DONE_PENDING_CONFIRM->WAITING_OTTER', {
    from: 'DONE_PENDING_CONFIRM', to: 'WAITING_OTTER',
    allowed: ['partner'],
    note: '「打回」：闭环确认不通过，退给负责獭续办',
  }],
  // CLOSED → OPEN：翻案（L1 獭自关后搭档不认可重开；L2 理论上无翻案入口但保留防误操作）
  ['CLOSED->OPEN', {
    from: 'CLOSED', to: 'OPEN',
    allowed: ['partner'],
    note: '翻案：搭档不认可闭环，重开',
  }],
  // OPEN/WAITING_* → SUPERSEDED：被新 matter 取代
  ['OPEN->SUPERSEDED', {
    from: 'OPEN', to: 'SUPERSEDED',
    allowed: ['any_otter'],
    note: '被新 matter 取代（登记 superseded_by）',
  }],
  ['WAITING_OTTER->SUPERSEDED', {
    from: 'WAITING_OTTER', to: 'SUPERSEDED',
    allowed: ['any_otter'],
    note: '被新 matter 取代（登记 superseded_by）',
  }],
  ['WAITING_PARTNER->SUPERSEDED', {
    from: 'WAITING_PARTNER', to: 'SUPERSEDED',
    allowed: ['any_otter'],
    note: '被新 matter 取代（登记 superseded_by）',
  }],
  ['DONE_PENDING_CONFIRM->SUPERSEDED', {
    from: 'DONE_PENDING_CONFIRM', to: 'SUPERSEDED',
    allowed: ['any_otter'],
    note: '被新 matter 取代（登记 superseded_by）',
  }],
  // OPEN/WAITING_* → ABANDONED：搭档明确不做
  ['OPEN->ABANDONED', {
    from: 'OPEN', to: 'ABANDONED',
    allowed: ['partner'],
    note: '搭档明确不做',
  }],
  ['WAITING_OTTER->ABANDONED', {
    from: 'WAITING_OTTER', to: 'ABANDONED',
    allowed: ['partner'],
    note: '搭档明确不做',
  }],
  ['WAITING_PARTNER->ABANDONED', {
    from: 'WAITING_PARTNER', to: 'ABANDONED',
    allowed: ['partner'],
    note: '搭档明确不做',
  }],
  ['DONE_PENDING_CONFIRM->ABANDONED', {
    from: 'DONE_PENDING_CONFIRM', to: 'ABANDONED',
    allowed: ['partner'],
    note: '搭档明确不做',
  }],
].map(([key, t]) => [key as string, t as MatterTransition]));

/** 查询一条迁移是否存在于合法矩阵 */
export function findMatterTransition(from: string, to: string): MatterTransition | undefined {
  return TRANSITIONS.get(`${from}->${to}`);
}
