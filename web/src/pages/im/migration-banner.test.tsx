// @vitest-environment jsdom
/**
 * #1211：存量 feishu 静态凭证迁移引导条渲染测试。
 *
 * 覆盖（deprecatedFeishuConfig 状态机）：
 * 1. true → 引导条出现（文案含迁移三步 + 文档指引），不显示为误导性「未配置」静默态
 * 2. 缺省（无旧段）→ 引导条不渲染，页面保持原状
 *
 * 数据流：loadChannelStatus → resp.deprecatedFeishuConfig === true → setDeprecatedFeishuConfig → banner。
 * api client 全量 mock（ImPage 依赖面广），断言只关注 banner 存在性。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as api from '../../api/client'
import ImPage from './index'

// jsdom 无 window.matchMedia：QRCodeLoginCard 断点逻辑需要（模式照 AppLayout.test.tsx）
beforeAll(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })))
})

// api client 全量 mock：ImPage 挂载即拉账号/应用/对话列表
vi.spyOn(api, 'listFeishuApps').mockResolvedValue([])
vi.spyOn(api, 'listWeixinAccounts').mockResolvedValue([])
vi.spyOn(api, 'listConversations').mockResolvedValue({ items: [] } as never)
vi.spyOn(api, 'deleteWeixinAccount').mockResolvedValue(undefined as never)
vi.spyOn(api, 'updateWeixinUserName').mockResolvedValue(undefined as never)
vi.spyOn(api, 'deleteFeishuApp').mockResolvedValue(undefined as never)
vi.spyOn(api, 'provisionWeixinAssistantLine').mockResolvedValue({} as never)

async function renderImPage(container: HTMLElement): Promise<Root> {
  const root = createRoot(container)
  await act(async () => {
    root.render(<ImPage />)
  })
  // 等 useEffect 数据加载 + 渲染稳定
  await act(async () => { await new Promise(r => setTimeout(r, 30)) })
  return root
}

describe('#1211 feishu 静态凭证迁移引导条', () => {
  it('deprecatedFeishuConfig=true：banner 出现且文案含迁移关键步骤', async () => {
    vi.spyOn(api, 'getChannelStatus').mockResolvedValue({
      channels: [],
      deprecatedFeishuConfig: true,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = await renderImPage(container)

    const banner = container.querySelector('[data-testid="feishu-migration-banner"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('旧版飞书静态凭证')
    expect(banner!.textContent).toContain('选择已有应用')
    expect(banner!.textContent).toContain('docs/user-guide/feishu-setup.md')

    await act(async () => { root.unmount() })
    container.remove()
  })

  it('无 deprecatedFeishuConfig（干净配置）：banner 不渲染', async () => {
    vi.spyOn(api, 'getChannelStatus').mockResolvedValue({ channels: [] })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = await renderImPage(container)

    expect(container.querySelector('[data-testid="feishu-migration-banner"]')).toBeNull()

    await act(async () => { root.unmount() })
    container.remove()
  })

  it('deprecatedFeishuConfig=false（显式 false 同缺省）：banner 不渲染', async () => {
    vi.spyOn(api, 'getChannelStatus').mockResolvedValue({
      channels: [],
      deprecatedFeishuConfig: false,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = await renderImPage(container)

    expect(container.querySelector('[data-testid="feishu-migration-banner"]')).toBeNull()

    await act(async () => { root.unmount() })
    container.remove()
  })
})
