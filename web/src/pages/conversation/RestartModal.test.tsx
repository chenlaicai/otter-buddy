/**
 * F20260924uxrc：确认即转后台交接后的 RestartModal 交互测试。
 *
 * 行为变更：原「await 期间弹窗锁死 + 按钮文案切封装中文案」已删——
 * index.confirmRestart 确认即关弹窗 + toast 后台反馈（搭档实证：
 * 停留在弹窗啥也干不了）。本测试钉死新行为：
 * 1. 勾选项默认勾选 / 取消勾选透传 false（保留自 F20260920uhuc）
 * 2. 确认 → 立即触发 onConfirmRestart（同步，不等 API）
 * 3. 防连点：点击后按钮进入 disabled 窗口，再次点击不重复触发
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

describe('RestartModal（F20260924uxrc 确认即转后台）', () => {
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

  it('确认 → 同步触发 onConfirmRestart（弹窗关闭由父级落地，不等 API）', async () => {
    const onConfirmRestart = vi.fn()
    renderRestartModal(onConfirmRestart)

    const confirm = await screen.findByRole('button', { name: '确认重启' })
    fireEvent.click(confirm)

    expect(onConfirmRestart).toHaveBeenCalledTimes(1)
    expect(onConfirmRestart).toHaveBeenCalledWith('', undefined, true)
  })

  it('防连点：确认后按钮 disabled，再次点击不重复触发', async () => {
    const onConfirmRestart = vi.fn()
    renderRestartModal(onConfirmRestart)

    const confirm = await screen.findByRole('button', { name: '确认重启' })
    fireEvent.click(confirm)
    // Modal 卸载由父级 setModal 驱动；jsdom 下父级未卸载时按钮处于 disabled 防连点窗口
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirmRestart).toHaveBeenCalledTimes(1)
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
