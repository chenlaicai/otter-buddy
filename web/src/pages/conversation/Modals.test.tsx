// @vitest-environment jsdom
/**
 * OtterDetailModal 世数链摘要折叠测试（F20260826xxxx model-badge-restore-and-modal-collapse）
 * - 历史世（restarted/archived）摘要默认 line-clamp-3 折叠，点击「展开」后全文可见
 * - 当前世（active）摘要始终完整展示，不受折叠影响
 * - fetchOtterProfile mock 为 reject：profile 不加载，聚焦 props.sessions 的世数链渲染
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConversationModals } from './Modals'
import type { LocalOtter as Otter, LocalOtterSession as OtterSession } from '../../lib/mappers'

vi.mock('../../api/client', () => ({
  fetchOtterProfile: vi.fn().mockRejectedValue(new Error('test: profile 不加载')),
  getSettings: vi.fn(),
}))

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function makeSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: 's1',
    otterId: 'o1',
    status: 'active',
    previousSessionId: null,
    startedAt: '2026-08-26 10:00:00',
    archivedAt: null,
    archiveReason: null,
    isNegativeCase: false,
    summary: null,
    ...overrides,
  }
}

const LONG_SUMMARY = '这是一段很长的前情摘要，多世海獭的交接词叠加会把弹窗垂直方向撑爆。'.repeat(6)

function renderDetailModal(sessions: OtterSession[]) {
  const conversationOtter = {
    id: 'o1', name: '测试獭', type: 'small', createdAt: '2026-08-25',
  } as Otter
  const noop = () => {}
  act(() => {
    root.render(
      <ConversationModals
        modal={{ type: 'otter-detail', otterId: 'o1' }}
        otters={[conversationOtter]}
        sessions={{ o1: sessions }}
        onClose={noop}
        onConfirmNewConv={noop}
        onConfirmChild={noop}
        onConfirmArchive={noop}
        onConfirmCreateOtter={noop}
        onConfirmDissolve={noop}
        onConfirmRestart={noop}
        onConfirmLinkResource={noop}
        onOpenRestart={noop}
        onOpenDissolve={noop}
      />
    )
  })
}

/** Modal 走 createPortal 挂 document.body，断言一律查 document 而非渲染容器 */
function querySummaries() {
  return Array.from(document.querySelectorAll('[data-testid="session-summary"]'))
}

/** F20260826mwbc 布局改版：内容双栏容器查询——左=身份信息，右=世代交接 */
function queryColumns() {
  const cols = document.querySelector('[data-testid="detail-columns"]')
  const [identity, generations] = Array.from(cols?.children ?? [])
  return { cols, identity, generations }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('OtterDetailModal 世数链摘要折叠', () => {
  it('内容双栏：左=身份信息、右=世代交接，为 columns 容器的直接子节点（含响应式类）', () => {
    renderDetailModal([
      makeSession({ id: 's1', status: 'active', previousSessionId: null, summary: '第一世剧情' }),
    ])
    const { cols, identity, generations } = queryColumns()
    // 容器存在且恰好两栏：桌面 sm: 双栏、默认单列（移动端全屏抽屉降级，#465）
    expect(cols).not.toBeNull()
    expect(cols!.className).toContain('sm:grid-cols-2')
    expect(cols!.className).toContain('grid-cols-1')
    expect(cols!.children.length).toBe(2)
    expect((identity as HTMLElement).dataset.testid).toBe('detail-column-identity')
    expect((generations as HTMLElement).dataset.testid).toBe('detail-column-generations')
    // 布局语义：身份信息在前（移动端堆叠在上），世代交接在后；
    // 世代交接包含世数链标题，身份栏包含属性区（类型字段）
    expect((generations as HTMLElement).textContent).toContain('转世履历')
    expect((identity as HTMLElement).textContent).toContain('类型')
    expect((identity as HTMLElement).textContent).not.toContain('转世履历')
  })

  it('历史世摘要默认折叠（line-clamp-3），当前世摘要完整展示不带 clamp 类', () => {
    renderDetailModal([
      makeSession({ id: 's1', status: 'restarted', previousSessionId: null, summary: LONG_SUMMARY, archivedAt: '2026-08-25 12:00:00' }),
      makeSession({ id: 's2', status: 'active', previousSessionId: 's1', summary: LONG_SUMMARY }),
    ])
    const summaries = querySummaries()
    expect(summaries.length).toBe(2)
    // 拉链排序首世在前：s1（历史世）折叠，s2（当前世）完整
    expect(summaries[0].className).toContain('line-clamp-3')
    expect(summaries[0].textContent).toBe(LONG_SUMMARY)
    expect(summaries[1].className).not.toContain('line-clamp-3')
    expect(summaries[1].textContent).toBe(`前情：${LONG_SUMMARY}`)
  })

  it('点击「展开」后历史世摘要移除 clamp 类、全文可见，按钮切换为「收起」', () => {
    renderDetailModal([
      makeSession({ id: 's1', status: 'archived', previousSessionId: null, summary: LONG_SUMMARY, archivedAt: '2026-08-25 12:00:00' }),
      makeSession({ id: 's2', status: 'active', previousSessionId: 's1', summary: LONG_SUMMARY }),
    ])
    const summaries = querySummaries()
    expect(summaries[0].className).toContain('line-clamp-3')
    const expandBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '展开')
    expect(expandBtn).not.toBeUndefined()
    act(() => { expandBtn!.click() })
    const after = querySummaries()
    expect(after[0].className).not.toContain('line-clamp-3')
    expect(after[0].textContent).toBe(LONG_SUMMARY)
    expect(Array.from(document.querySelectorAll('button')).some(b => b.textContent === '收起')).toBe(true)
  })

  it('当前世摘要无展开按钮（不折叠不切换），仅历史世有', () => {
    renderDetailModal([
      makeSession({ id: 's1', status: 'restarted', previousSessionId: null, summary: '第一世的交接词', archivedAt: '2026-08-25 12:00:00' }),
      makeSession({ id: 's2', status: 'active', previousSessionId: 's1', summary: '第二世正在进行的剧情' }),
    ])
    const toggleBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent === '展开' || b.textContent === '收起')
    // 仅历史世 1 个切换按钮；当前世摘要纯展示
    expect(toggleBtns.length).toBe(1)
    const summaries = querySummaries()
    expect(summaries[1].textContent).toBe('前情：第二世正在进行的剧情')
  })
})

// ═══ F20260826ucrt：CreateOtterModal 重做测试 ═══
// getSettings 在文件头 vi.mock 工厂中导出，这里 import 后按需 mock 返回值
import { getSettings } from '../../api/client'
import { fireEvent } from '@testing-library/react'
const getSettingsMock = vi.mocked(getSettings)

function renderCreateModal(onConfirm: (form: unknown) => void) {
  const noop = () => {}
  act(() => {
    root.render(
      <ConversationModals
        modal={{ type: 'create-otter' }}
        otters={[]}
        sessions={{}}
        onClose={noop}
        onConfirmNewConv={noop}
        onConfirmChild={noop}
        onConfirmArchive={noop}
        onConfirmCreateOtter={onConfirm as () => void}
        onConfirmDissolve={noop}
        onConfirmRestart={noop}
        onConfirmLinkResource={noop}
        onOpenRestart={noop}
        onOpenDissolve={noop}
      />
    )
  })
}

describe('F20260826ucrt CreateOtterModal', () => {
  beforeEach(() => {
    getSettingsMock.mockReset()
    getSettingsMock.mockResolvedValue({
      models: [
        { alias: 'glm', provider: 'zhipu', model: 'glm-5' },
        { alias: 'kimi', provider: 'moonshot', model: 'kimi-k3' },
      ],
      defaultModelAlias: 'glm',
      userName: '',
      port: 3000,
    } as unknown as Parameters<typeof getSettingsMock.mockResolvedValue>[0])
  })

  it('渲染模型下拉（settings 数据源）+ 头像「随机」与九宫格', async () => {
    renderCreateModal(() => {})
    // 等下拉数据加载
    await act(async () => { await Promise.resolve() })
    const select = document.querySelector('select') as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.options.length).toBe(2)
    expect(select.value).toBe('glm') // 默认选中 defaultModelAlias

    // 头像：随机独立项（radio）+ 3×3 九宫格（9 个按钮）
    const radio = document.querySelector('input[type="radio"]') as HTMLInputElement
    expect(radio?.checked).toBe(true) // 随机默认选中
    const gridButtons = Array.from(document.querySelectorAll('button[title]')) as HTMLButtonElement[]
    const gridButtonsTitled = gridButtons.filter((b): b is HTMLButtonElement => Boolean(b.title))
    expect(gridButtonsTitled.length).toBe(9)
  })

  it('mockSkills 与上下文注入摆设控件已删除', () => {
    renderCreateModal(() => {})
    expect(document.body.textContent).not.toContain('code-review')
    expect(document.body.textContent).not.toContain('上下文注入')
    expect(document.body.textContent).not.toContain('大獭将从记忆系统中提取')
  })

  it('提交组装表单对象（含 modelAlias/avatarName/systemPrompt 引导生成）', async () => {
    let submitted: unknown = null
    renderCreateModal(form => { submitted = form })
    await act(async () => { await Promise.resolve() })

    const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[]
    const nameInput = inputs[0]
    act(() => { fireEvent.change(nameInput, { target: { value: '分析獭' } }) })

    // 选第三款头像
    const gridButtons = (Array.from(document.querySelectorAll('button[title]')) as HTMLButtonElement[]).filter(b => b.title)
    act(() => { fireEvent.click(gridButtons[2]) })

    const createBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '创建')
    act(() => { fireEvent.click(createBtn!) })

    expect(submitted).toBeTruthy()
    const form = submitted as Record<string, unknown>
    expect(form.name).toBe('分析獭')
    expect(typeof form.systemPrompt).toBe('string')
    expect(form.systemPrompt).toContain('你是分析獭')
    expect(form.modelAlias).toBe('glm')
    expect(form.avatarName).toBeTruthy()
  })

  it('高级编辑：开启预填当前生成内容', async () => {
    renderCreateModal(() => {})
    await act(async () => { await Promise.resolve() })

    const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[]
    act(() => { fireEvent.change(inputs[0], { target: { value: '高级獭' } }) })

    const advCheckbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => { fireEvent.click(advCheckbox) })

    await act(async () => { await Promise.resolve() })
    const textarea = document.querySelector('textarea.font-mono') as HTMLTextAreaElement
    expect(textarea).toBeTruthy()
    expect(textarea.value).toContain('你是高级獭')
  })
})
