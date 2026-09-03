/**
 * RHI 健康面板图表色板（Issue #647 项 5：色彩 token 统一）
 *
 * 纪律三条（观澜 3.4）：
 * 1. 图表库默认色（蓝 #0ea5e9 / 绿 #10b981 / 橙 #f59e0b 等）全面退场——系列色
 *    需求用 teal 阶 + otter 阶 + caramel 阶 + lavender 阶解决（globals.css @theme 同值）。
 * 2. 红色只允许出现在「需要行动」的元素（critical 信号、骤降箭头）；装饰性用色禁红——
 *    BugFix 比率线（中性指标）禁用警示色。
 * 3. 跨图表色义锁定：同一 token 在任何图表中语义不变
 *    （teal=健康/修复、caramel=注意/热、otter-300=失活、lavender=悬空/辅助）。
 *
 * 值与 web/src/styles/globals.css @theme 的 token 一一对应（recharts 无法直接
 * 消费 CSS 变量字符串场景下的 fallback；stroke/fill 均支持 var() 但 Tooltip
 * 等内联场景取值不稳，故直接落 token 同值——token 变更时两处同步改）。
 */

/** teal 阶（健康/修复/正向） */
export const TEAL = { 300: '#7BC5C5', 400: '#4A9B9B', 500: '#3A8B8B', 600: '#2A7B7B' } as const
/** caramel 阶（注意/热/复发；700=严重/回退深阶，观澜 §3.4） */
export const CARAMEL = { 300: '#E8B98E', 400: '#D9A57B', 500: '#C9956B', 600: '#8F6234', 700: '#6B4924' } as const
/** otter 阶（失活/中性/背景） */
export const OTTER = { 100: '#F0E8DC', 200: '#E0D0BC', 300: '#C9AC8E', 400: '#A88260', 500: '#8B6F47', 700: '#52402C', 900: '#2A2014' } as const
/** lavender 阶（悬空/辅助） */
export const LAVENDER = { 400: '#9B8AC8', 500: '#8B7AB8' } as const

/** stone 阶（tailwind 原生，图表轴/网格沿用） */
export const STONE = { 300: '#d6d3d1', 400: '#a8a29e', 500: '#78716c' } as const

/**
 * 分类系列色（8 槽，替换 recharts 默认蓝绿橙序列）：
 * teal-500 → caramel-500 → lavender-400 → otter-400 → teal-600 → caramel-600 → otter-300 → otter-700
 */
export const SERIES_COLORS = [
  TEAL[500], CARAMEL[500], LAVENDER[400], OTTER[400],
  TEAL[600], CARAMEL[600], OTTER[300], OTTER[700],
] as const

/** change_type → 色义锁定映射（环形图等分类场景；未识别类型落 otter-300） */
export const CHANGE_TYPE_COLORS: Record<string, string> = {
  '新功能': TEAL[400],
  '修复': CARAMEL[500],
  '重构': LAVENDER[400],
  '文档': OTTER[300],
  '测试': TEAL[300],
  '杂务': OTTER[200],
  '实验': CARAMEL[300],
}

/* 链五态色不在此定义：活映射是 index.tsx 的 CHAIN_STATE_LABELS（teal=活跃、
 * caramel=滞留/回退、otter-300=僵尸/孤儿）——单一真相源，勿在此复制第二份
 * （曾并行存在语义漂移的死导出 CHAIN_STATE_COLORS，检视建议 7 删除） */
