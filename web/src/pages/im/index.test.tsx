// @vitest-environment jsdom
/**
 * ImPage 组件测试（#1079）——三路覆盖：
 * ① 流程状态机：idle → naming → connecting 转换、取消/返回路径（微信 + 飞书同款）
 * ② 覆盖确认弹层：同号命中展示、覆盖执行、两步错误语义（delete 失败 vs provision 失败）
 * ③ 账号列表：assistantLine 投影渲染（已建线/未建线两态）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import ImPage from './index'
import * as api from '../../api/client'
import { showToast } from '../../components/Toast'
import type { WeixinAccountDTO } from '../../api/client'

// Toast 静默 + 可断言
vi.mock('../../components/Toast', () => ({ showToast: vi.fn() }))

// 二维码子组件 stub：暴露「模拟扫码确认」按钮直接回调 onLoginConfirmed，
// 把 ImPage 内部的 handleLoginConfirmed 同号识别/建线路径拉进测试面
vi.mock('../../components/weixin/QRCodeLoginCard', () => ({
  QRCodeLoginCard: ({ lineName, onLoginConfirmed }: { lineName: string; onLoginConfirmed: (accountId?: string) => void }) => (
    <div>
      <span data-testid="weixin-qr-stub">qr:{lineName}</span>
      <button onClick={() => onLoginConfirmed('acc-new')}>模拟扫码确认</button>
    </div>
  ),
}))
vi.mock('../../components/feishu/FeishuQRCodeLoginCard', () => ({
  FeishuQRCodeLoginCard: ({ lineName, onLoginConfirmed }: { lineName: string; onLoginConfirmed: () => void }) => (
    <div>
      <span data-testid="feishu-qr-stub">qr:{lineName}</span>
      <button onClick={() => onLoginConfirmed()}>模拟飞书扫码</button>
    </div>
  ),
}))

function account(over: Partial<WeixinAccountDTO> = {}): WeixinAccountDTO {
  return { id: 'acc-1', addedAt: '2026-01-01T00:00:00Z', hasToken: true, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 默认 stub：空数据，各用例按需覆盖
  vi.spyOn(api, 'listWeixinAccounts').mockResolvedValue([] as never)
  vi.spyOn(api, 'listConversations').mockResolvedValue({ items: [], total: 0 } as never)
  vi.spyOn(api, 'getChannelStatus').mockResolvedValue({ channels: [] } as never)
  vi.spyOn(api, 'listFeishuApps').mockResolvedValue([] as never)
  vi.spyOn(api, 'provisionWeixinAssistantLine').mockResolvedValue({ conversationId: 'c1', title: 't' } as never)
  vi.spyOn(api, 'deleteWeixinAccount').mockResolvedValue({ status: 'ok' } as never)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 进入微信命名步（idle → naming） */
function enterNaming() {
  fireEvent.click(screen.getByText('＋ 新建助理连接'))
  screen.getByText('第 1 步 · 给助理起名')
}

/** 命名步输入名字并进下一步（naming → connecting） */
function enterConnecting(name = '我的微信') {
  enterNaming()
  fireEvent.change(screen.getByPlaceholderText('输入助理名字（必填）'), { target: { value: name } })
  fireEvent.click(screen.getByText('下一步：扫码'))
}

describe('① 流程状态机（微信：idle → naming → connecting）', () => {
  it('idle → naming：点新建按钮进入第 1 步命名', () => {
    render(<ImPage />)
    enterNaming()
  })

  it('naming：名字为空时「下一步」disabled', () => {
    render(<ImPage />)
    enterNaming()
    fireEvent.change(screen.getByPlaceholderText('输入助理名字（必填）'), { target: { value: '   ' } })
    expect((screen.getByText('下一步：扫码') as HTMLButtonElement).disabled).toBe(true)
  })

  it('naming → connecting：输入名字点下一步，二维码卡带名字渲染', () => {
    render(<ImPage />)
    enterConnecting('小獭的微信')
    expect(screen.getByTestId('weixin-qr-stub').textContent).toBe('qr:小獭的微信')
  })

  it('naming → connecting：Enter 键提交', () => {
    render(<ImPage />)
    enterNaming()
    fireEvent.change(screen.getByPlaceholderText('输入助理名字（必填）'), { target: { value: '回车命名' } })
    fireEvent.keyDown(screen.getByPlaceholderText('输入助理名字（必填）'), { key: 'Enter' })
    expect(screen.getByTestId('weixin-qr-stub').textContent).toBe('qr:回车命名')
  })

  it('connecting → naming：返回修改名字，已填名字保留', () => {
    render(<ImPage />)
    enterConnecting('想改的名字')
    fireEvent.click(screen.getByText('← 返回修改名字'))
    screen.getByText('第 1 步 · 给助理起名')
    expect((screen.getByPlaceholderText('输入助理名字（必填）') as HTMLInputElement).value).toBe('想改的名字')
  })

  it('naming → idle：取消回到新建按钮', () => {
    render(<ImPage />)
    enterNaming()
    fireEvent.click(screen.getByText('取消'))
    screen.getByText('＋ 新建助理连接')
  })
})

describe('① 流程状态机（飞书：idle → naming → connecting）', () => {
  it('飞书扫码流程两步转换 + 返回 + 取消', () => {
    render(<ImPage />)
    fireEvent.click(screen.getByText('+ 扫码接入飞书'))
    // naming 步：空名 disabled
    expect((screen.getByText('下一步：扫码') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('给助理起个名字（如 joy 的小助手）'), { target: { value: '飞书助理' } })
    fireEvent.click(screen.getByText('下一步：扫码'))
    expect(screen.getByTestId('feishu-qr-stub').textContent).toBe('qr:飞书助理')
    // connecting → naming：返回修改名字
    fireEvent.click(screen.getByText('← 返回修改名字'))
    expect((screen.getByPlaceholderText('给助理起个名字（如 joy 的小助手）') as HTMLInputElement).value).toBe('飞书助理')
    // naming → idle：取消
    fireEvent.click(screen.getByText('取消'))
    screen.getByText('+ 扫码接入飞书')
  })
})

describe('② 覆盖确认弹层', () => {
  /** 同号命中场景：扫码产生的 acc-new 与存量 acc-old 同 ilinkUserId */
  function stubDuplicate(hasLine: boolean) {
    vi.spyOn(api, 'listWeixinAccounts').mockResolvedValue([
      account({ id: 'acc-new', ilinkUserId: 'u1' }),
      account({ id: 'acc-old', ilinkUserId: 'u1', assistantLine: hasLine ? { conversationId: 'c-old' } : undefined }),
    ] as never)
    vi.spyOn(api, 'listConversations').mockResolvedValue({
      items: hasLine ? [{ id: 'c-old', title: '旧助理线', status: 'active', pinned: false, otterIds: [], createdAt: '', updatedAt: '' }] : [],
      total: hasLine ? 1 : 0,
    } as never)
  }

  async function triggerLoginConfirmed() {
    enterConnecting()
    await act(async () => {
      fireEvent.click(screen.getByText('模拟扫码确认'))
    })
  }

  it('同号命中展示（已建线）：弹层出现且文案含「且已建助理线」', async () => {
    render(<ImPage />)
    stubDuplicate(true)
    await triggerLoginConfirmed()
    screen.getByRole('dialog', { name: '同号覆盖确认' })
    screen.getByText(/刚才扫的微信号与已有连接是同一个（且已建助理线）/)
  })

  it('同号命中展示（未建线）：文案含「但未完成建线」', async () => {
    render(<ImPage />)
    stubDuplicate(false)
    await triggerLoginConfirmed()
    screen.getByRole('dialog', { name: '同号覆盖确认' })
    screen.getByText(/刚才扫的微信号与已有连接是同一个（但未完成建线）/)
  })

  it('覆盖执行成功：删旧账号 → 新号建线 → 弹层关闭', async () => {
    render(<ImPage />)
    stubDuplicate(true)
    await triggerLoginConfirmed()
    await act(async () => {
      fireEvent.click(screen.getByText('覆盖，用新名字建线'))
    })
    expect(api.deleteWeixinAccount).toHaveBeenCalledWith('acc-old')
    expect(api.provisionWeixinAssistantLine).toHaveBeenCalledWith('acc-new', '我的微信', undefined)
    expect(screen.queryByRole('dialog', { name: '同号覆盖确认' })).toBeNull()
    expect(showToast).toHaveBeenCalledWith('助理「我的微信」已就绪 🦦', 'success')
  })

  it('两步错误语义 · delete 失败：toast「未做任何变更」，弹层保留，provision 不执行', async () => {
    render(<ImPage />)
    stubDuplicate(true)
    vi.mocked(api.deleteWeixinAccount).mockRejectedValue(new Error('boom') as never)
    await triggerLoginConfirmed()
    await act(async () => {
      fireEvent.click(screen.getByText('覆盖，用新名字建线'))
    })
    expect(showToast).toHaveBeenCalledWith('旧账号删除失败，未做任何变更', 'error')
    expect(api.provisionWeixinAssistantLine).not.toHaveBeenCalled()
    // 弹层保留（可原地重试）
    screen.getByRole('dialog', { name: '同号覆盖确认' })
  })

  it('两步错误语义 · provision 失败：toast「旧账号已清理」，弹层关并回 idle', async () => {
    render(<ImPage />)
    stubDuplicate(true)
    vi.mocked(api.provisionWeixinAssistantLine).mockRejectedValue(new Error('boom') as never)
    await triggerLoginConfirmed()
    await act(async () => {
      fireEvent.click(screen.getByText('覆盖，用新名字建线'))
    })
    expect(api.deleteWeixinAccount).toHaveBeenCalledWith('acc-old')
    expect(showToast).toHaveBeenCalledWith('旧账号已清理，但建线失败——请重新新建助理连接', 'error')
    expect(screen.queryByRole('dialog', { name: '同号覆盖确认' })).toBeNull()
    // resetFlow：回到新建按钮
    screen.getByText('＋ 新建助理连接')
  })

  it('「不覆盖，取消」：弹层关、流程回 idle，不做任何删除', async () => {
    render(<ImPage />)
    stubDuplicate(true)
    await triggerLoginConfirmed()
    await act(async () => {
      fireEvent.click(screen.getByText('不覆盖，取消'))
    })
    expect(screen.queryByRole('dialog', { name: '同号覆盖确认' })).toBeNull()
    screen.getByText('＋ 新建助理连接')
    expect(api.deleteWeixinAccount).not.toHaveBeenCalled()
    expect(api.provisionWeixinAssistantLine).not.toHaveBeenCalled()
  })

  it('无同号冲突：扫码确认直接建线（不弹覆盖层）', async () => {
    render(<ImPage />)
    vi.spyOn(api, 'listWeixinAccounts').mockResolvedValue([account({ id: 'acc-new', ilinkUserId: 'u-new' })] as never)
    await triggerLoginConfirmed()
    expect(screen.queryByRole('dialog', { name: '同号覆盖确认' })).toBeNull()
    await waitFor(() => expect(api.provisionWeixinAssistantLine).toHaveBeenCalledWith('acc-new', '我的微信', undefined))
  })
})

describe('③ 账号列表：assistantLine 投影渲染', () => {
  /** 数据在 mount 时由 useEffect 拉取——必须先 stub 再 render（render 后覆盖 mock 不生效） */
  function stubThenRender(accounts: WeixinAccountDTO[], convs: Array<{ id: string; title: string; lastMessagePreview?: string | null }>) {
    vi.spyOn(api, 'listWeixinAccounts').mockResolvedValue(accounts as never)
    vi.spyOn(api, 'listConversations').mockResolvedValue({
      items: convs.map(c => ({ ...c, status: 'active', pinned: false, otterIds: [], createdAt: '', updatedAt: '' })),
      total: convs.length,
    } as never)
    render(<ImPage />)
  }

  it('空态：无账号时提示「还没有连接的微信账号」', async () => {
    stubThenRender([], [])
    await waitFor(() => screen.getByText('还没有连接的微信账号'))
  })

  it('已建线：渲染投影 title + 最近消息预览', async () => {
    stubThenRender(
      [account({ assistantLine: { conversationId: 'c1' } })],
      [{ id: 'c1', title: '小獭的微信', lastMessagePreview: '你好呀' }],
    )
    await waitFor(() => screen.getByText('小獭的微信'))
    screen.getByText('助理线 · 你好呀')
  })

  it('已建线无消息：预览回落「暂无消息」', async () => {
    stubThenRender(
      [account({ assistantLine: { conversationId: 'c1' } })],
      [{ id: 'c1', title: '小獭的微信', lastMessagePreview: null }],
    )
    await waitFor(() => screen.getByText('助理线 · 暂无消息'))
  })

  it('未建线（无 assistantLine）：回落「未命名连接」+ 异常指引文案', async () => {
    stubThenRender([account()], [])
    await waitFor(() => screen.getByText('未命名连接'))
    screen.getByText('扫码未完成或助理线异常（可删除后重新新建）')
  })

  it('投影缺失（assistantLine 指向的对话不在列表）：同未建线回落', async () => {
    stubThenRender([account({ assistantLine: { conversationId: 'c-gone' } })], [])
    await waitFor(() => screen.getByText('未命名连接'))
    screen.getByText('扫码未完成或助理线异常（可删除后重新新建）')
  })
})
