// @vitest-environment jsdom
/**
 * #576（F20260901emps）：能力库页面非空冒烟断言——防「页面静默空白」回归。
 * 用户 8/28 原话「能力库和记忆搜索页面上内容其实都是空的，这不好」。
 *
 * F20260924uxrc 书式改版（搭档拍板：双页摊开秘籍书）后锁定点：
 * 1. API 正常：封面渲染（书名 + 心法数）+ 摊开后章目录/技能页内容非空
 * 2. 三段式 description 解析：Use when / Not for / Output 各自锚定成槽
 * 3. API 失败：降级内置清单 + 封面「离线兜底」标注（非静默空白）
 * 4. API 空：显式空态文案（非静默空白）
 * 5. 翻页：goView 语义（点热区 / 章节耳直达）——jsdom 无 3D 渲染，断言 DOM 语义
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

const REAL_SKILLS = [
  {
    name: 'companion',
    description: 'Use when: 自由协作讨论. Not for: 匹配其他 skill. Output: 自然对话.',
  },
  { name: 'core-workflow', description: '查询对话历史、搜索记忆、记录决策和产出。' },
]

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
    expect(p.when).not.toContain('MUST')
    expect(p.output).not.toContain('Precondition')
  })
})

describe('能力库书式页面（#576 + F20260924uxrc spread 书）', () => {
  it('API 正常：封面渲染（书名 + 心法统计 + 无离线标注）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ skills: REAL_SKILLS }), { status: 200 }),
    )
    render()
    await act(async () => {})

    const text = container.textContent ?? ''
    expect(text).toContain('獭族能力秘籍')
    expect(text).toContain('2 门心法')
    expect(container.querySelector('[data-testid="degraded-badge"]')).toBeNull()
  })

  it('摊开视野1：壹章目录 + companion 技能页同框，三槽解析成槽', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ skills: REAL_SKILLS }), { status: 200 }),
    )
    render()
    await act(async () => {})

    // 点右热区摊开（封面 → 视野1）
    const zones = Array.from(container.querySelectorAll<HTMLElement>('div[style*="cursor: pointer"]'))
    const rightZone = zones.find(z => z.style.right === '0px')
    expect(rightZone).toBeTruthy()
    act(() => { rightZone!.click() })
    await act(async () => {})

    const text = container.textContent ?? ''
    // 摊开后：章目录 + 技能页都在 DOM（sheet 正反面）
    expect(text).toContain('搭档之道')
    expect(text).toContain('companion')
    // companion 是结构化描述 → 三槽标签渲染
    expect(text).toContain('施展')
    expect(text).toContain('忌用')
    expect(text).toContain('产出')
    // core-workflow 非结构化 → 整段 raw 展示
    expect(text).toContain('查询对话历史')
  })

  it('章节耳：五流派耳存在，点耳直达章目录视野', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ skills: REAL_SKILLS }), { status: 200 }),
    )
    render()
    await act(async () => {})

    const ears = Array.from(container.querySelectorAll<HTMLButtonElement>('button[title^="直达"]'))
    expect(ears.length).toBe(5) // 壹..伍 五章耳（2 skill 只归入两章，但耳固定五章）
    // 点叁章耳 → 视野切到叁章目录页所在视野
    act(() => { ears[2].click() })
    await act(async () => {})
    // jsdom 无过渡计时器完成等待——goView 立即 setView，DOM 已更新
    expect(container.textContent).toContain('修行之路')
  })

  it('API 失败：降级内置清单 + 封面离线兜底标注（非静默空白）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    render()
    await act(async () => {})

    const text = container.textContent ?? ''
    expect(text).toContain('獭族能力秘籍')
    expect(text).toContain('离线兜底')
    expect(container.querySelector('[data-testid="degraded-badge"]')).toBeTruthy()
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

describe('翻页引擎边界（检视獭-uxrc2 发现回归防护：连击 off-by-one + 奇偶末页可达）', () => {
  /** 用例素材：奇数内容页场景—— 章(1)+1 skill + 章(1)+2 skill = 5 内容页（奇数），
   *  sheet=3，maxView=3：末视野 = p5(末 skill) | 底衬页 */
  const ODD_SKILLS = [
    { name: 'companion', description: 'Use when: 聊. Output: 天.' },
    { name: 'core-workflow', description: '查历史。' },
    { name: 'troubleshooting', description: '排查。' },
  ]

  it('奇数内容页：末技能页可达（maxView 翻得到最后一门）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ skills: ODD_SKILLS }), { status: 200 }),
    )
    render()
    await act(async () => {})

    // 直接点右热区到 maxView（每步等动画窗口结束，避免连击排队路径）
    const next = () => container.querySelector<HTMLElement>('[data-testid="nav-next"]')!
    for (let i = 0; i < 10; i++) {
      const before = (container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view
      act(() => { next().click() })
      await new Promise(r => setTimeout(r, 700)) // 等动画窗口（650ms）关闭
      await act(async () => {})
      const after = (container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view
      if (before === after) break // clamp 生效，到 maxView
    }
    const finalView = Number((container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view)
    // 奇数内容页（5）：maxView = 3；末视野左页 = p5 = troubleshooting（最后技能页可达）
    expect(finalView).toBeGreaterThanOrEqual(3)
    expect(container.textContent).toContain('troubleshooting')
  })

  it('TOC 条目可点直达：点壹章目录首条目 → 跳到 companion 秘籍页', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ skills: ODD_SKILLS }), { status: 200 }),
    )
    render()
    await act(async () => {})

    // 摊开到壹目录（视野 1）
    act(() => { container.querySelector<HTMLElement>('[data-testid="nav-next"]')!.click() })
    await act(async () => {})
    // 点目录首条目（companion）
    const tocBtns = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .filter(b => b.textContent?.includes('companion') && b.textContent?.includes('翻阅'))
    expect(tocBtns.length).toBeGreaterThanOrEqual(1)
    act(() => { tocBtns[0].click() })
    await act(async () => {})
    const view = Number((container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view)
    // companion = 内容页 p2，位于视野 1
    expect(view).toBe(1)
  })

  it('连击不丢步（off-by-one 回归）：快速双击右热区，view 立即 2（回放基准=落地 view）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ skills: ODD_SKILLS }), { status: 200 }),
    )
    render()
    await act(async () => {})

    const next = () => container.querySelector<HTMLElement>('[data-testid="nav-next"]')!
    // 双击：第一次立即 view 0→1；第二次在动画窗口内（步进排队 +1）→ 回放后应为 2
    act(() => { next().click() })
    act(() => { next().click() })
    await act(async () => {})
    let view = Number((container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view)
    expect(view).toBe(1) // 排队中：立即态为 1，回放要等 FLIP_MS
    // 快进 650ms（fake timer 风格：直接等真实定时器，vitest jsdom 可等待）
    await new Promise(r => setTimeout(r, 700))
    await act(async () => {})
    view = Number((container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view)
    expect(view).toBe(2) // 原 bug：回放基准用旧 view → 双击落 1；修复后落 2
  })
})
