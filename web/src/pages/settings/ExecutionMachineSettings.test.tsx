// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ExecutionMachineSettings } from './ExecutionMachineSettings'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('ExecutionMachineSettings', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('展示全部已注册机器与在线状态，并提供系统级添加设备入口', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ machines: [
      { id: 'hub-connector', name: '中枢执行机', online: true, lastSeenAt: '2026-11-25T08:00:00Z' },
      { id: 'connector-b', name: 'B 机', online: false, lastSeenAt: '2026-11-24T08:00:00Z' },
    ] })))
    vi.stubGlobal('fetch', fetchMock)
    render(<ExecutionMachineSettings />)

    await waitFor(() => expect(screen.getByTestId('execution-machine-hub-connector')).toBeTruthy())
    expect(screen.getByTestId('execution-machine-hub-connector').textContent).toContain('在线')
    expect(screen.getByTestId('execution-machine-connector-b').textContent).toContain('离线')
    expect(screen.getByTestId('connector-onboarding')).toBeTruthy()
    expect(screen.getByRole('button', { name: '生成配对码' })).toBeTruthy()
    expect(screen.getByTestId('download-connector')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/execution-machines', { credentials: 'same-origin' })
    expect(screen.queryByText(/对话执行机|当前执行机|回默认/)).toBeNull()
  })

  it('空池给出注册指引，不虚构内置 local 机器', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ machines: [] }))))
    render(<ExecutionMachineSettings />)
    await waitFor(() => expect(screen.getByText(/暂无已注册执行机/)).toBeTruthy())
    expect(screen.queryByText('本机')).toBeNull()
  })

  it('刷新失败显示真实错误，重试成功后恢复列表', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ machines: [
        { id: 'connector-b', name: 'B 机', online: true, lastSeenAt: '2026-11-25T08:00:00Z' },
      ] })))
    vi.stubGlobal('fetch', fetchMock)
    render(<ExecutionMachineSettings />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('登录已过期'))

    fireEvent.click(screen.getByTitle('刷新执行机列表'))
    await waitFor(() => expect(screen.getByTestId('execution-machine-connector-b')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
