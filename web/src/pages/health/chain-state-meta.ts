/**
 * 链四态元数据（Issue #649 PR3 抽出共享；F20260902sigm 五态→四态）。
 *
 * 动机：index.tsx 在 import 时挂载 #root（createRoot 副作用），组件测试无法
 * 直接 import 其内部常量——历史测试（RecurrenceCard.test.tsx）只能复制字面量。
 * 泳道/筛选/抽屉与 index.tsx 需要同一份色义与排序权重，单一真相源在此。
 *
 * F20260902sigm：zombie 删除（链是开放结构，不预言未来）；stalled 语义改为
 * pr-stalled（open PR 停滞）。
 *
 * 色彩纪律（palette.ts + 观澜 §3.4）：teal=活跃、caramel=滞留/回退、
 * lavender-400=孤儿（悬空/辅助）。跨图表色义锁定：同一 token 在泳道 SVG、
 * chips、抽屉徽章中语义不变。
 */
import { TEAL, CARAMEL, LAVENDER } from './palette'

export type ChainState = 'active' | 'stalled' | 'regressed' | 'orphan'

/** 四态标签 + 文本色类 + 图表色（色义锁定，palette token 同值） */
export const CHAIN_STATE_META: Record<ChainState, { label: string; className: string; color: string }> = {
  active: { label: '活跃', className: 'text-teal-700', color: TEAL[500] },
  stalled: { label: 'PR 停滞', className: 'text-caramel-600', color: CARAMEL[500] },
  regressed: { label: '回退', className: 'text-caramel-600', color: CARAMEL[600] },
  orphan: { label: '孤儿', className: 'text-lavender-500', color: LAVENDER[400] },
}

/** 排序权重：状态严重度优先（regressed 最高），同态按最近活动降序由调用方补 */
export function chainStateRank(state: string): number {
  const order: Record<string, number> = { regressed: 4, stalled: 3, orphan: 2, active: 1 }
  return order[state] ?? 0
}

/** 异常态（筛选 chips 展示序=严重优先，§3.2 视觉反转：异常实心/活跃灰显描边） */
export const ANOMALY_STATES: ChainState[] = ['stalled', 'regressed', 'orphan']

/** commit changeType → 中文标签（原 index.tsx 重复定义收编；链抽屉/泳道 tooltip 共用） */
export const CHANGE_TYPE_LABELS: Record<string, string> = {
  Feature: '新功能', BugFix: '修复', Refactor: '重构', Docs: '文档',
  Test: '测试', Chore: '杂务', Experiment: '实验',
}

/** 泳道节点色：bug 系 commit=caramel、其他=teal（复发卡同款色义；锁定 #649 拍板） */
export function commitNodeColor(changeType: string | null): string {
  return changeType === 'BugFix' || changeType === 'Experiment' ? CARAMEL[500] : TEAL[400]
}
