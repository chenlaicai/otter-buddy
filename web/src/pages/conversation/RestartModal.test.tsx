/**
 * F20260918uhuc：RestartModal 交互测试（UI 真机自查的组件层补充）。
 *
 * 真机 Playwright 取证：空前世场景重启秒级完成，submitting 文案（正在封装前世档案…）
 * 与防连点窗口 <50ms 采样不到——本测试用 jsdom 受控环境钉死这两个行为：
 * 1. 确认后按钮进入 submitting 态（文案切换 + disabled）
 * 2. submitting 期间再次点击不重复触发 onConfirmRestart
 * 3. 勾选项默认勾选 / 取消勾选透传 false
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConversationModals, type ModalState } from './Modals'
import type { LocalOtter as Otter } from '../../lib/mappers'

const baseOtter: Otter = {
  id: 'big-otter', name: '大獭', type: 'big', modelAlias: 'kimi',
  level: 1, badge: null, createdAt: '2026-09-18T00:00:00Z',
  stats: { speaks: 0, artifacts: 0, conversations: 1 },
} as unknown as Otter

function renderRestartModal(onConfirmRestart: (s: string, m?: string, sp?: boolean) => void) {
  const modal: ModalState = { type: 'restart', otterId: 'big-otter' }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jsdom fetch stub（getSettings 降级）
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch
  return render(
    <ConversationModals
      modal={modal}
      otters={[baseOtter]}
      sessions={{}}
      onClose={() => {}}
      onConfirmNewConv={() => {}}
      onConfirmArchive={() => {}}
      onConfirmCreateOtter={() => {}}
      onConfirmDissolve={() => {}}
      onConfirmRestart={onConfirmRestart}
      onConfirmLinkResource={() => {}}
      onOpenRestart={() => {}}
      onOpenDissolve={() => {}}
    />,
  )
}

describe('RestartModal（F20260918uhuc 统一交接）', () => {
  it('「生成前世总结」勾选项默认勾选，说明文案区分勾/不勾形态', async () => {
    renderRestartModal(() => {})
    const toggle = await screen.findByTestId('synthesize-past-toggle')
    const checkbox = toggle.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    expect(screen.getByText(/引擎叙事合成/)).toBeTruthy()

    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox.checked).toBe(false))
    expect(screen.getByText(/跳过合成秒级换世/)).toBeTruthy()
  })

  it('确认后进入交接态：文案切换 + disabled 防连点 + 不重复触发', async () => {
    const onConfirmRestart = vi.fn()
    renderRestartModal(onConfirmRestart)

    const confirm = await screen.findByRole('button', { name: '确认重启' })
    fireEvent.click(confirm)

    // submitting 态：按钮文案切换且 disabled
    const submitting = await screen.findByRole('button', { name: /正在封装前世档案/ })
    expect((submitting as HTMLButtonElement).disabled).toBe(true)

    // 防连点：submitting 期间再点击不触发第二次
    fireEvent.click(submitting)
    expect(onConfirmRestart).toHaveBeenCalledTimes(1)
    expect(onConfirmRestart).toHaveBeenCalledWith('', undefined, true)
  })

  it('取消勾选后确认 → synthesizePast=false 透传', async () => {
    const onConfirmRestart = vi.fn()
    renderRestartModal(onConfirmRestart)

    const toggle = await screen.findByTestId('synthesize-past-toggle')
    fireEvent.click(toggle.querySelector('input[type="checkbox"]') as HTMLInputElement)
    const confirm = await screen.findByRole('button', { name: '确认重启' })
    fireEvent.click(confirm)

    await waitFor(() => expect(onConfirmRestart).toHaveBeenCalledWith('', undefined, false))
  })
})
