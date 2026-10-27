// @vitest-environment jsdom
/**
 * D1 修复验证：设置页渲染测试——防「useBlocker 在非数据路由下崩溃」回归。
 *
 * 核心断言：
 * 1. 设置页能正常渲染（不崩溃、不白屏）
 * 2. useBlocker 在数据路由下正常工作
 * 3. 页面包含预期内容（设置标题、模型选择等）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider, Outlet } from 'react-router-dom'
import { resetBackgroundPreference } from '../../lib/background-preference'
import { setBackgroundSnapshot } from '../../lib/background-preference-store'

const { selectBackgroundImageMock, removeBackgroundPreferenceMock, showToastMock } = vi.hoisted(() => ({
  selectBackgroundImageMock: vi.fn(),
  removeBackgroundPreferenceMock: vi.fn(),
  showToastMock: vi.fn(),
}))
vi.mock('../../lib/background-preference', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/background-preference')>()
  return {
    ...actual,
    selectBackgroundImage: selectBackgroundImageMock,
    removeBackgroundPreference: removeBackgroundPreferenceMock,
  }
})
vi.mock('../../components/Toast', () => ({ showToast: showToastMock }))

document.body.innerHTML = '<div id="root"></div>'
const { default: SettingsPage } = await import('./index')

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  selectBackgroundImageMock.mockResolvedValue(undefined)
  removeBackgroundPreferenceMock.mockResolvedValue(undefined)
  localStorage.clear()
  resetBackgroundPreference()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
  localStorage.clear()
  resetBackgroundPreference()
})

async function changeBackgroundFile(file: File) {
  const input = container.querySelector('[data-testid="background-file-input"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

/** Mock API 返回设置数据 */
function mockSettingsApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/settings')) {
      return new Response(JSON.stringify({
        models: [
          { alias: 'default', provider: 'openai', model: 'gpt-4', strengths: ['fast'], weaknesses: ['cheap'], contextWindow: 128000 },
        ],
        defaultModelAlias: 'default',
        userName: '测试用户',
        port: 3116,
        dbPath: '/tmp/test.db',
        embeddingModelPath: '/tmp/embedding',
        embeddingDim: 1024,
      }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

/** 创建数据路由器——useBlocker 的正规前置条件 */
function createTestRouter() {
  return createMemoryRouter([
    {
      path: '/',
      element: <div><Outlet /></div>,
      children: [
        { index: true, element: <SettingsPage /> },
      ],
    },
  ], {
    // 初始 URL 必须匹配路由路径
    initialEntries: ['/'],
  })
}

function render() {
  act(() => {
    root.render(<RouterProvider router={createTestRouter()} />)
  })
}

describe('设置页渲染测试（D1 修复验证）', () => {
  it('显示默认背景，选择合法图片后提示成功', async () => {
    mockSettingsApi()
    render()
    await act(async () => {})

    expect(container.textContent).toContain('背景图片')
    expect(container.textContent).toContain('默认彩色背景')
    expect(container.textContent).toContain('保存在应用启动目录，重开浏览器或重启应用仍保留')
    await changeBackgroundFile(new File(['image'], 'landscape.png', { type: 'image/png' }))
    expect(selectBackgroundImageMock).toHaveBeenCalled()
    expect(showToastMock).toHaveBeenCalledWith('背景图片已更换', 'success')
  })

  it('选图失败展示真实错误，不宣称已保存', async () => {
    mockSettingsApi()
    selectBackgroundImageMock.mockRejectedValue(new Error('图片已损坏或无法解码，请换一张图片'))
    render()
    await act(async () => {})

    await changeBackgroundFile(new File(['bad'], 'bad.png', { type: 'image/png' }))

    expect(showToastMock).toHaveBeenCalledWith('图片已损坏或无法解码，请换一张图片', 'error')
    expect(showToastMock).not.toHaveBeenCalledWith('背景图片已更换', 'success')
  })

  it('已有自定义图片时可恢复默认并删除应用目录资产', async () => {
    mockSettingsApi()
    setBackgroundSnapshot('/api/settings/background?v=1&otterUserId=web-ui&otterRole=admin')
    render()
    await act(async () => {})

    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '恢复默认背景') as HTMLButtonElement
    await act(async () => { button.click(); await Promise.resolve() })

    expect(removeBackgroundPreferenceMock).toHaveBeenCalled()
    resetBackgroundPreference()
    await act(async () => {})
    expect(container.textContent).toContain('默认彩色背景')
    expect(showToastMock).toHaveBeenCalledWith('已恢复默认彩色背景', 'success')
  })

  it('设置页能正常渲染（不崩溃、不白屏）', async () => {
    mockSettingsApi()
    render()
    await act(async () => {})

    // 验证页面包含预期内容
    expect(container.textContent).toContain('设置')
    expect(container.textContent).toContain('模型')
    expect(container.textContent).toContain('默认模型')
  })

  it('设置页包含用户信息', async () => {
    mockSettingsApi()
    render()
    await act(async () => {})

    // 验证用户信息显示——input 的 value 不在 textContent 里，需查 DOM 属性
    const input = container.querySelector('input[type="text"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(input!.value).toBe('测试用户')
  })

  it('设置页包含系统参数', async () => {
    mockSettingsApi()
    render()
    await act(async () => {})

    // 验证系统参数显示
    expect(container.textContent).toContain('服务端口')
    expect(container.textContent).toContain('3116')
    expect(container.textContent).toContain('数据库路径')
  })
})
