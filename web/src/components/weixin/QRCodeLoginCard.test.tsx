// @vitest-environment jsdom
/**
 * QRCodeLoginCard 测试（#1112 最小面）——聚焦本次变更行为：
 * ① binded_redirect → already_connected 终态：文案渲染、toast 提示、
 *    不触发 onLoginConfirmed（无新账号可建线）、停轮询
 * ② success 分支回归对照：既有分流行为不回退
 *
 * 组件全面测试面（二维码渲染/取消/重试/配对码等）归 #1079 检视 2 派生的
 * 待立案项（净增熔断期暂不立），本文件只覆盖 #1112 行为改动。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, screen, act } from '@testing-library/react'
import { QRCodeLoginCard } from './QRCodeLoginCard'
import * as api from '../../api/client'
import { showToast } from '../../components/Toast'
import type { WeixinLoginSessionDTO } from '../../api/client'

vi.mock('../../components/Toast', () => ({ showToast: vi.fn() }))

function session(over: Partial<WeixinLoginSessionDTO> = {}): WeixinLoginSessionDTO {
  return { id: 'sess-1', status: 'pending', createdAt: '2026-01-01T00:00:00Z', ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  // mock 数据一律在 render 前 stub（mount 后覆盖无效——#1079 惯例）
  vi.spyOn(api, 'startWeixinLogin').mockResolvedValue(session())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 点「显示二维码」发起登录并推进一个轮询周期（2s interval + async 回放） */
async function startAndPoll(): Promise<void> {
  render(<QRCodeLoginCard lineName="我的微信" onLoginConfirmed={vi.fn()} />)
  fireEvent.click(screen.getByText('显示二维码'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0) // flush startWeixinLogin promise
    await vi.advanceTimersByTimeAsync(2100) // 首轮轮询
  })
}

describe('QRCodeLoginCard (#1112 already_connected 终态)', () => {
  it('binded_redirect → already_connected：文案渲染 + info toast + 不触发 onLoginConfirmed', async () => {
    vi.spyOn(api, 'getWeixinLogin').mockResolvedValue(session({ status: 'already_connected' }))
    const onLoginConfirmed = vi.fn()
    render(<QRCodeLoginCard lineName="我的微信" onLoginConfirmed={onLoginConfirmed} />)
    fireEvent.click(screen.getByText('显示二维码'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2100)
    })

    expect(screen.getByText('该微信已连接过，无需重复连接')).toBeDefined()
    expect(showToast).toHaveBeenCalledWith('该微信已连接过此实例，无需重复连接', 'info')
    // 无新账号可建线——不触发扫码确认回调（与 success 分流的关键差异）
    expect(onLoginConfirmed).not.toHaveBeenCalled()
  })

  it('already_connected 终态后停轮询（getWeixinLogin 调用数不再增长）', async () => {
    const getWeixinLogin = vi
      .spyOn(api, 'getWeixinLogin')
      .mockResolvedValue(session({ status: 'already_connected' }))
    await startAndPoll()
    const callsAtTerminal = getWeixinLogin.mock.calls.length
    expect(callsAtTerminal).toBeGreaterThanOrEqual(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000) // 终态后继续推进 5 个轮询周期
    })
    expect(getWeixinLogin.mock.calls.length).toBe(callsAtTerminal)
  })

  it('already_connected 后「重新扫码」按钮可用（不在禁用态，可重新发起）', async () => {
    vi.spyOn(api, 'getWeixinLogin').mockResolvedValue(session({ status: 'already_connected' }))
    await startAndPoll()
    const retryBtn = screen.getByText('重新扫码') as HTMLButtonElement
    expect(retryBtn.disabled).toBe(false)
  })

  it('回归对照：success 终态仍触发 onLoginConfirmed + success toast（既有分流不回退）', async () => {
    vi.spyOn(api, 'getWeixinLogin').mockResolvedValue(session({ status: 'success', accountId: 'acc-9' }))
    const onLoginConfirmed = vi.fn()
    render(<QRCodeLoginCard lineName="我的微信" onLoginConfirmed={onLoginConfirmed} />)
    fireEvent.click(screen.getByText('显示二维码'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2100)
    })

    expect(onLoginConfirmed).toHaveBeenCalledWith('acc-9')
    expect(showToast).toHaveBeenCalledWith('「我的微信」已连接', 'success')
  })
})
