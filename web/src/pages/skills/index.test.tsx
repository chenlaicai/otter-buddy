// @vitest-environment jsdom
/**
 * #576（F20260901emps）：能力库页面非空冒烟断言——防「页面静默空白」回归。
 *
 * 用户 8/28 原话「能力库和记忆搜索页面上内容其实都是空的，这不好」。
 * F20260924uxrc 改版（图鉴式分组卡阵）后锁定点升级：
 * 1. API 正常时渲染真实 skill 卡阵（卡片非空 + 三段式解析分槽展示）
 * 2. API 失败时降级内置清单 + 「离线兜底」标注（非静默空白）
 * 3. API 返回空数组时显式空态文案（非静默空白）
 * 4. 三段式 description 解析：Use when / Not for / Output 各自锚定成槽
 * 5. 卡片点击展开秘籍全文（toggle 行为）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

document.body.innerHTML = '<div id="root"></div>'
const { default: SkillsPage, parseSkillDescription } = await import('./index')

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

describe('parseSkillDescription（F20260924uxrc 三段式解析）', () => {
  it('标准三段式：Use when / Not for / Output 各自锚定', () => {
    const p = parseSkillDescription(
      'Use when: 搭档要求按方案实现功能. Not for: 无方案的需求分析 → requirement-analysis. Output: 代码 PR + 特性文档.',
    )
    expect(p.when).toContain('按方案实现功能')
    expect(p.notFor).toContain('requirement-analysis')
    expect(p.output).toContain('代码 PR')
  })

  it('只言片语：仅部分段存在时其余为 null', () => {
    const p = parseSkillDescription('Use when: 排查问题.')
    expect(p.when).toBe('排查问题.')
    expect(p.notFor).toBeNull()
    expect(p.output).toBeNull()
  })

  it('非结构化文案：三段全 null，raw 兜底（降级清单走这条）', () => {
    const p = parseSkillDescription('结构化排查：从症状到根因到修复')
    expect(p.when).toBeNull()
    expect(p.notFor).toBeNull()
    expect(p.output).toBeNull()
    expect(p.raw).toBe('结构化排查：从症状到根因到修复')
  })

  it('Precondition 行不污染三段', () => {
    const p = parseSkillDescription(
      'Precondition: MUST trigger BEFORE modifying. Use when: 准备提交 git 文件. Output: worktree + commit.',
    )
    expect(p.when).toContain('准备提交')
    expect(p.output).toContain('worktree')
    // Precondition 文本不进任何槽（展开态才可见全文）
    expect(p.when).not.toContain('MUST')
    expect(p.output).not.toContain('Precondition')
  })
})

describe('能力库页面非空冒烟（#576 + F20260924uxrc 图鉴卡阵）', () => {
  it('API 正常：渲染 skill 卡阵（卡片非空 + 三段式分槽）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        skills: [
          {
            name: 'companion',
            description: 'Use when: 自由协作. Not for: 结构化流程. Output: 对话.',
          },
          { name: 'core-workflow', description: '信息查询与产出记录' },
        ],
      }), { status: 200 }),
    )
    render()
    await act(async () => {}) // flush microtasks（fetch resolve → setState）

    // 图鉴卡阵：article 卡片替代原 aside 列表
    const cards = document.querySelectorAll('article')
    expect(cards.length).toBeGreaterThanOrEqual(2)
    expect(container.textContent).toContain('companion')
    // 三段式解析成槽：施展/忌用/产出 标签 + 内容（companion 卡）
    expect(container.textContent).toContain('施展')
    expect(container.textContent).toContain('忌用')
    expect(container.textContent).toContain('产出')
    // 非结构化文案（core-workflow）整段展示，不装模作样拆槽
    expect(container.textContent).toContain('信息查询与产出记录')
  })

  it('卡片点击展开秘籍全文（toggle）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        skills: [
          {
            name: 'companion',
            description: 'Use when: 自由协作. Not for: 结构化流程. Output: 对话. Precondition: 无.',
          },
        ],
      }), { status: 200 }),
    )
    render()
    await act(async () => {})

    const card = document.querySelector('article') as HTMLElement
    // 初始折叠：全文（含 Precondition）不可见
    expect(card.textContent).not.toContain('Precondition')
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})
    expect(card.textContent).toContain('Precondition')
    // 再点收起
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})
    expect(card.textContent).not.toContain('Precondition')
  })

  it('API 失败：降级内置清单 + 离线标注（非静默空白）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    render()
    await act(async () => {})

    expect(container.textContent).toContain('companion')
    expect(container.textContent).toContain('离线')
    // 降级清单文案非结构化 → 整段 raw 展示，不出现空槽标签
    expect(container.textContent).toContain('兜底模式')
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
