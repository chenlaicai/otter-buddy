/**
 * 走向箭头（issue #1029 从 index.tsx 抽出——TrendIcon 有既有单测 TrendIcon.test.tsx，
 * VerdictPanel 证据层复用同一组件，单一真相源在此）。
 * 后端 TrendDirection：improving/stable/declining，不足 8 点 null。
 */

import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react'

export function TrendIcon({ direction }: { direction?: 'improving' | 'stable' | 'declining' | null }) {
  if (direction === 'improving') return <ArrowUpRight className="w-3.5 h-3.5 text-emerald-500" />
  if (direction === 'declining') return <ArrowDownRight className="w-3.5 h-3.5 text-rose-500" />
  if (direction === 'stable') return <Minus className="w-3.5 h-3.5 text-stone-400" />
  return <Minus className="w-3.5 h-3.5 text-stone-300" />
}
