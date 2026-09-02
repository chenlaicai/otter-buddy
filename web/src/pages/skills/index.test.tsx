// @vitest-environment jsdom
/**
 * #576（F20260901emps）：能力库页面非空冒烟断言——防「页面静默空白」回归。
 *
 * 用户 8/28 原话「能力库和记忆搜索页面上内容其实都是空的，这不好」。
 * 本测试锁三个不可回退点：
 * 1. API 正常时渲染真实 skill 清单（列表非空 + 详情面板非空）
 * 2. API 失败时降级内置清单 + 「离线兜底」标注（非静默空白）
 * 3. API 返回空数组时显式空态文案（非静默空白）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

document.body.innerHTML = '<div id="root"></div>'
const { SkillsPage } = await import('./index')

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

function render() {
  act(() => { root.render(<SkillsPage />) })
}

describe('能力库页面非空冒烟（#576）', () => {
  it('API 正常：渲染真实 skill 清单（列表与详情均非空）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        skills: [
          { name: 'companion', description: '兜底模式' },
          { name: 'core-workflow', description: '信息查询' },
        ],
      }), { status: 200 }),
    )
    render()
    await act(async () => {}) // flush microtasks（fetch resolve → setState）

    const listItems = document.querySelectorAll('.cursor-pointer')
    expect(listItems.length).toBeGreaterThanOrEqual(2)
    expect(container.textContent).toContain('companion')
    // 详情面板（main 区域，不含侧边栏 aside）：首项自动选中（#689 审视建议 1 回归锁定）。
    // 若 selectedName 未初始化缺陷回归（selectedSkill undefined），h2 不存在，断言失败。
    const main = container.querySelector('main')
    expect(main?.querySelector('h2')?.textContent).toBe('companion')
    expect(main?.textContent).toContain('兜底模式')
  })

  it('API 失败：降级内置清单 + 离线标注（非静默空白）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    render()
    await act(async () => {})

    expect(container.textContent).toContain('companion')
    expect(container.textContent).toContain('离线兜底'.slice(0, 2)) // 「离线」标注存在
    expect(container.textContent).toContain('离线')
    // 降级态同样自动选中首项（#689 建议 1）
    expect(container.querySelector('main')?.querySelector('h2')?.textContent).toBe('companion')
  })

  it('API 返回空数组：显式空态文案（非静默空白）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ skills: [] }), { status: 200 }),
    )
    render()
    await act(async () => {})

    expect(container.textContent).toContain('未发现任何 skill')
  })
})
