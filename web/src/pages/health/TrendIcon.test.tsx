// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// 页面入口（./index.tsx）在 import 时 createRoot(#root).render 挂载全页，
// 测试环境无 #root 会抛 Target container 错——先建容器再 import（入口副作用，非 TrendIcon 逻辑）
document.body.innerHTML = '<div id="root"></div>'
const { TrendIcon } = await import('./index')

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** F20260830hdbh 审视修复：TrendIcon 枚举与后端 TrendDirection（improving/stable/declining）
 *  契约一致性参数化测试——此前 up/down/flat 枚举不匹配导致箭头恒显灰平（审视严重发现 1）。 */
function renderIcon(direction: 'improving' | 'stable' | 'declining' | null): string {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => { root.render(<TrendIcon direction={direction} />) })
  const svg = container.querySelector('svg')
  return svg?.getAttribute('class') ?? ''
}

describe('TrendIcon（后端 TrendDirection 契约）', () => {
  it('improving → 绿色上箭头', () => {
    expect(renderIcon('improving')).toContain('text-emerald-500')
  })
  it('declining → 红色下箭头', () => {
    expect(renderIcon('declining')).toContain('text-rose-500')
  })
  it('stable → 灰平（stone-400）', () => {
    expect(renderIcon('stable')).toContain('text-stone-400')
  })
  it('null（不足 8 数据点）→ 浅灰平（stone-300，与 stable 视觉区分）', () => {
    expect(renderIcon(null)).toContain('text-stone-300')
  })
})
