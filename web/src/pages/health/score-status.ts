/**
 * 健康分状态色配置（issue #595：绿≥75 / 黄 50-74 / 红<50，与后端 statusFromScore 对齐）。
 * issue #1029 从 index.tsx 抽出：总览三层组件（VerdictPanel）与 index.tsx 共用，单一真相源。
 */

export const SCORE_STATUS_CONFIG: Record<string, { label: string; text: string; bg: string; border: string }> = {
  green: { label: '健康', text: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  yellow: { label: '观察', text: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200' },
  red: { label: '告警', text: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-200' },
}
