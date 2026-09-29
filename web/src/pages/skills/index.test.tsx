// @vitest-environment jsdom
/**
 * #576（F20260901emps）：能力库页面非空冒烟断言——防「页面静默空白」回归。
 * F20260924uxrc 书式改版（搭档拍板：双页摊开秘籍书）。
 * F20260929scfx 能力库全书（搭档拍板，对话 9eeb7b69）：书重排三编——
 *   卷首·心法总纲（SYSTEM.md 分节全文）/ 卷中·招式秘籍（正文全文+续页）/ 卷末·兵器谱。
 * 锁定点：
 * 1. 封面渲染（书名 + 心法数）+ 三编结构（目录页/心法页/技能页/兵器谱页）
 * 2. 三段式 description 解析（parseSkillDescription 回归）
 * 3. skill 页渲染正文内容片段（F20260929scfx 新断言）
 * 4. 心法总纲 section 页存在（F20260929scfx 新断言）
 * 5. 兵器谱 tools 渲染（F20260929scfx 新断言）
 * 6. 序号与页序一致：第N门 = 书页顺序编号（F20260929scfx 新断言）
 * 7. API 失败：降级内置清单 + 封面「离线兜底」标注；prompts 单独失败：仅卷首/卷末降级
 * 8. API 空：显式空态文案（非静默空白）
 * 9. 翻页引擎边界（检视獭-uxrc2 回归防护）：连击 off-by-one + 奇偶末页可达
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

document.body.innerHTML = '<div id="root"></div>'
const { default: SkillsPage, parseSkillDescription, paginateText, buildPages, viewOfPageIdx } = await import('./index')

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

const REAL_PROMPTS = {
  system: [
    { title: '第一性原理（Axioms，A 层）', content: '你是独立的思考者和诚实的专业协作者。\n\n优先级链：事实 > 搭档判断 > AI 偏好。' },
    { title: '世界观（Worldview，W 层）', content: '海獭是有名字的唯一实体。\n\nAI 是独立思考者不是服从工具。' },
  ],
  tools: [
    { name: 'speak', description: '发言工具——你在聊天室里唯一的发言通道。' },
    { name: 'yield', description: '交棒工具——结束本轮行动。' },
    { name: 'search_memory', description: '检索记忆。' },
  ],
}

/** 双源 mock：/api/skills 与 /api/prompts 分别响应 */
function mockFetch(skills: unknown[] | null, prompts: typeof REAL_PROMPTS | null = REAL_PROMPTS, opts?: { skillsFail?: boolean }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api/prompts')) {
      if (prompts === null) return Promise.reject(new Error('prompts down'))
      return Promise.resolve(new Response(JSON.stringify(prompts), { status: 200 }))
    }
    if (opts?.skillsFail) return Promise.reject(new Error('skills down'))
    if (skills === null) return Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    return Promise.resolve(new Response(JSON.stringify({ skills }), { status: 200 }))
  })
}

/** API 格式（description 字段；组件 fetch 后 map 成内部 desc） */
const REAL_SKILLS = [
  {
    name: 'companion',
    description: 'Use when: 自由协作讨论. Not for: 匹配其他 skill. Output: 自然对话.',
    body: '# Companion\n\n不匹配任何 skill 时的兜底模式。\n\n像朋友一样协作，不端着流程。',
  },
  {
    name: 'core-workflow',
    description: '查询对话历史、搜索记忆、记录决策和产出。',
    body: '# Core Workflow\n\n查与记的标准动作。',
  },
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

describe('paginateText（F20260929scfx 长文分页）', () => {
  it('短文本单页', () => {
    expect(paginateText('a\nb\nc', 5)).toEqual(['a\nb\nc'])
  })

  it('超页高按行装箱切多页，不截词（按整行粒度）', () => {
    const text = Array.from({ length: 7 }, (_, i) => `line-${i}`).join('\n')
    const pages = paginateText(text, 3)
    expect(pages).toHaveLength(3)
    expect(pages[0]).toBe('line-0\nline-1\nline-2')
    expect(pages[2]).toBe('line-6')
  })

  it('空文本兜底单页空串', () => {
    expect(paginateText('', 5)).toEqual([''])
  })
})

describe('buildPages（F20260929scfx 三编组页）', () => {
  it('页序：编目 → 心法节（含续页） → 章目录+skill 页（含续页） → 兵器谱', () => {
    const { pages: builtPages } = buildPages(REAL_SKILLS, REAL_PROMPTS)
    const kinds = builtPages.map(p => p.kind)
    const pages = builtPages
    // p0 编目
    expect(kinds[0]).toBe('toc')
    // 心法两节（内容短 → 各 1 页）
    expect(kinds[1]).toBe('section')
    expect(pages[1].sectionIdx).toBe(0)
    expect(kinds[2]).toBe('section')
    expect(pages[2].sectionIdx).toBe(1)
    // 章目录 + skill 页
    expect(kinds[3]).toBe('chapterToc')
    expect(kinds[4]).toBe('skill')
    expect(pages[4].skillIdx).toBe(0)
    // 兵器谱
    expect(kinds[kinds.length - 1]).toBe('tools')
  })

  it('长 section 自动续页（cont 递增）', () => {
    const longContent = Array.from({ length: 70 }, (_, i) => `sec-line-${i}`).join('\n')
    const { pages } = buildPages([], { system: [{ title: '长节', content: longContent }], tools: [] })
    const secPages = pages.filter(p => p.kind === 'section')
    expect(secPages.length).toBeGreaterThan(1)
    expect(secPages[0].cont).toBe(0)
    expect(secPages[1].cont).toBe(1)
    // 续页文本是切片而非全文
    expect(secPages[1].text).not.toContain('sec-line-0')
    expect(secPages[1].text).toContain(`sec-line-${30}`)
  })

  it('长 skill 正文自动续页', () => {
    const longBody = Array.from({ length: 65 }, (_, i) => `body-line-${i}`).join('\n')
    const { pages } = buildPages(
      [{ name: 'companion', desc: 'Use when: 聊. Output: 天.', body: longBody }],
      { system: [], tools: [] },
    )
    const skillPages = pages.filter(p => p.kind === 'skill' && p.skillIdx === 0)
    expect(skillPages.length).toBeGreaterThan(1)
    expect(skillPages[1].cont).toBe(1)
  })

  it('prompts 为 null：卷首/卷末编跳过，卷中保留', () => {
    const { pages } = buildPages(REAL_SKILLS, null)
    expect(pages.some(p => p.kind === 'section')).toBe(false)
    expect(pages.some(p => p.kind === 'tools')).toBe(false)
    expect(pages.some(p => p.kind === 'skill')).toBe(true)
  })

  it('viewOfPageIdx：页序→视野映射（0/1 同视野摊开）', () => {
    expect(viewOfPageIdx(0)).toBe(1) // p0 右页（视野1）
    expect(viewOfPageIdx(1)).toBe(1) // p1 左页（视野1）
    expect(viewOfPageIdx(2)).toBe(2) // p2 右页（视野2）
  })
})

describe('能力库全书页面（F20260929scfx 三编结构）', () => {
  it('封面渲染：书名 + 心法数 + 编数；无降级标注', async () => {
    mockFetch(REAL_SKILLS)
    render()
    await act(async () => {})

    const text = container.textContent ?? ''
    expect(text).toContain('獭族能力秘籍')
    expect(text).toContain('2 门心法')
    expect(container.querySelector('[data-testid="degraded-badge"]')).toBeNull()
  })

  it('视野1：编目页 + 心法首节同框（三编数据源到位）', async () => {
    mockFetch(REAL_SKILLS)
    render()
    await act(async () => {})

    act(() => { container.querySelector<HTMLElement>('[data-testid="nav-next"]')!.click() })
    await act(async () => {})

    const text = container.textContent ?? ''
    expect(text).toContain('全帙目录')
    expect(text).toContain('第一性原理')
    expect(text).toContain('卷中 · 招式秘籍')
    expect(text).toContain('卷末 · 兵器谱')
  })

  it('skill 页渲染正文内容片段（F20260929scfx 新断言）', async () => {
    mockFetch(REAL_SKILLS)
    render()
    await act(async () => {})

    // companion = skillIdx 0 → 起始内容页：编目1 + 心法2 + 壹目录1 = p3 → 视野 2
    act(() => { container.querySelector<HTMLElement>('[data-testid="nav-next"]')!.click() })
    await new Promise(r => setTimeout(r, 700))
    await act(async () => {})
    act(() => { container.querySelector<HTMLElement>('[data-testid="nav-next"]')!.click() })
    await act(async () => {})

    const text = container.textContent ?? ''
    // 正文区含 body 片段（非 frontmatter description）
    expect(text).toContain('不匹配任何 skill 时的兜底模式')
    // companion 是结构化描述 → 三槽标签渲染
    expect(text).toContain('施展')
    expect(text).toContain('忌用')
    expect(text).toContain('产出')
  })

  it('心法总纲 section 页存在且渲染正文（F20260929scfx 新断言）', async () => {
    mockFetch(REAL_SKILLS)
    render()
    await act(async () => {})

    // 视野1 左页 = 编目？页序 p0 编目（右页，视野1）p1 心法第〇则（左页，视野1）
    act(() => { container.querySelector<HTMLElement>('[data-testid="nav-next"]')!.click() })
    await act(async () => {})

    const text = container.textContent ?? ''
    expect(text).toContain('第一性原理（Axioms，A 层）')
    expect(text).toContain('你是独立的思考者和诚实的专业协作者')
    // 节序页脚标注（cnNum(0) = 第一则）
    expect(text).toContain('第一则')
  })

  it('兵器谱 tools 渲染（F20260929scfx 新断言）', async () => {
    mockFetch(REAL_SKILLS)
    render()
    await act(async () => {})

    // 直接翻到末视野（内容页 11 → maxView 6）
    for (let i = 0; i < 6; i++) {
      const before = (container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view
      act(() => { container.querySelector<HTMLElement>('[data-testid="nav-next"]')!.click() })
      await new Promise(r => setTimeout(r, 700))
      await act(async () => {})
      const after = (container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view
      if (before === after) break
    }
    const text = container.textContent ?? ''
    expect(text).toContain('兵器谱')
    expect(text).toContain('speak')
    expect(text).toContain('search_memory')
    expect(text).toContain('运行时注册工具全集')
  }, 12000)

  it('序号与页序一致：第N门按书页顺序编号（F20260929scfx 新断言）', async () => {
    mockFetch(REAL_SKILLS)
    render()
    await act(async () => {})

    // 编目页内两 skill 条目的编号 = 全局序（companion=0 → 第一门，core-workflow=1 → 第二门）
    act(() => { container.querySelector<HTMLElement>('[data-testid="nav-next"]')!.click() })
    await act(async () => {})
    const text = container.textContent ?? ''
    expect(text).toContain('第一门 · companion')
    expect(text).toContain('第二门 · core-workflow')
  })

  it('prompts 端点失败：卷首/卷末降级 + 封面离线兜底标注；skills 正常', async () => {
    mockFetch(REAL_SKILLS, null)
    render()
    await act(async () => {})

    const text = container.textContent ?? ''
    expect(text).toContain('獭族能力秘籍')
    expect(text).toContain('离线兜底')
    expect(container.querySelector('[data-testid="degraded-badge"]')).toBeTruthy()
    // skills 正常 → 卷中编仍在（摊开后可见章目录）
    act(() => { container.querySelector<HTMLElement>('[data-testid="nav-next"]')!.click() })
    await act(async () => {})
    expect(container.textContent).toContain('卷中 · 招式秘籍')
  })

  it('skills 端点失败：整书降级内置清单 + 离线兜底标注', async () => {
    mockFetch(null, null, { skillsFail: true })
    render()
    await act(async () => {})

    const text = container.textContent ?? ''
    expect(text).toContain('獭族能力秘籍')
    expect(text).toContain('离线兜底')
    // 内置兜底清单 14 门渲染
    expect(text).toContain('companion')
    expect(text).toContain('visual-design')
  })

  it('skills 返回空数组：显式空态文案（非静默空白）', async () => {
    mockFetch([])
    render()
    await act(async () => {})

    expect(container.textContent).toContain('未发现任何 skill')
  })
})

describe('翻页引擎边界（检视獭-uxrc2 回归防护：连击 off-by-one + 奇偶末页可达）', () => {
  const ODD_SKILLS = [
    { name: 'companion', description: 'Use when: 聊. Output: 天.', body: '正文一。' },
    { name: 'core-workflow', description: '查历史。', body: '正文二。' },
    { name: 'troubleshooting', description: '排查。', body: '正文三。' },
  ]

  it('奇数内容页：末技能页可达（maxView 翻得到最后一门）', async () => {
    mockFetch(ODD_SKILLS, { system: [], tools: [] })
    render()
    await act(async () => {})

    const next = () => container.querySelector<HTMLElement>('[data-testid="nav-next"]')!
    for (let i = 0; i < 20; i++) {
      const before = (container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view
      act(() => { next().click() })
      await new Promise(r => setTimeout(r, 700))
      await act(async () => {})
      const after = (container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view
      if (before === after) break
    }
    expect(container.textContent).toContain('troubleshooting')
  })

  it('连击不丢步（off-by-one 回归）：快速双击右热区，回放后 view = 2', async () => {
    mockFetch(ODD_SKILLS, { system: [], tools: [] })
    render()
    await act(async () => {})

    const next = () => container.querySelector<HTMLElement>('[data-testid="nav-next"]')!
    act(() => { next().click() })
    act(() => { next().click() })
    await act(async () => {})
    let view = Number((container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view)
    expect(view).toBe(1)
    await new Promise(r => setTimeout(r, 700))
    await act(async () => {})
    view = Number((container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view)
    expect(view).toBe(2)
  })

  it('同向三连击不丢步（终验 N3 回归钉死）', async () => {
    mockFetch([
      { name: 'companion', description: 'Use when: 聊. Output: 天.', body: '一' },
      { name: 'core-workflow', description: '查历史。', body: '二' },
      { name: 'troubleshooting', description: '排查。', body: '三' },
      { name: 'requirement-analysis', description: 'Use when: 方案. Output: 文档.', body: '四' },
      { name: 'code-implementation', description: 'Use when: 写码. Output: PR.', body: '五' },
      { name: 'worktree-isolation', description: 'Use when: git. Output: worktree.', body: '六' },
      { name: 'otter-summon', description: 'Use when: 召唤. Output: 编排.', body: '七' },
      { name: 'visual-design', description: 'Use when: 设计. Output: 稿.', body: '八' },
    ], { system: [], tools: [] })
    render()
    await act(async () => {})

    const next = () => container.querySelector<HTMLElement>('[data-testid="nav-next"]')!
    act(() => { next().click() })
    act(() => { next().click() })
    act(() => { next().click() })
    await new Promise(r => setTimeout(r, 750))
    await act(async () => {})
    let view = Number((container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view)
    expect(view).toBe(3)

    act(() => { next().click() })
    act(() => { next().click() })
    act(() => { next().click() })
    act(() => { next().click() })
    await new Promise(r => setTimeout(r, 750))
    await act(async () => {})
    view = Number((container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view)
    expect(view).toBe(7)
  })

  it('动画窗口内点章耳直达：落绝对目标视野非 +1 步', async () => {
    mockFetch(ODD_SKILLS, { system: [], tools: [] })
    render()
    await act(async () => {})

    // ODD 3 skill + 空 prompts：页序 p0编目 p1心法(无,跳过) ... 实际：p0编目 p1壹目录 p2companion p3贰目录 p4core p5trouble p6叁目录 p7肆目录 p8伍目录 = 9 内容页
    // 叁目录 p6 → 视野 4（2*4-2=6 左页）
    act(() => { container.querySelector<HTMLElement>('[data-testid="nav-next"]')!.click() })
    // 耳列表：卷首(0) + 伍章(1..5) + 卷末(6)
    const ears = Array.from(container.querySelectorAll<HTMLButtonElement>('button[title^="直达"]'))
    const ear3 = ears[3] // 叁章耳
    act(() => { ear3.click() })
    await new Promise(r => setTimeout(r, 750))
    await act(async () => {})
    const view = Number((container.querySelector('[data-testid="skills-book"]') as HTMLElement).dataset.view)
    expect(view).toBe(4)
  })
})
