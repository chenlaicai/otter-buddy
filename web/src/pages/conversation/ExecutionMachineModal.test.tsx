// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ExecutionMachineModal } from './ExecutionMachineModal'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const actionsFixture = [
  { actionId: 'a-1', deviceId: 'connector-b', actionType: 'workspace.write', status: 'succeeded', error: null, createdAt: '2026-11-18T06:00:00Z', settledAt: '2026-11-18T06:00:01Z' },
  { actionId: 'a-2', deviceId: 'hub-connector', actionType: 'bash', status: 'unknown', error: 'timeout after 30000ms', createdAt: '2026-11-18T05:00:00Z', settledAt: null },
]

describe('ExecutionMachineModal（统一注册制：仅动作状态）', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('只请求对话动作台账，展示全部执行机状态，不请求已移除的绑定 API', async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(jsonResponse({ actions: actionsFixture })))
    vi.stubGlobal('fetch', fetchMock)
    render(<ExecutionMachineModal conversationId="c-1" onClose={() => {}} />)

    await waitFor(() => expect(screen.getAllByText('workspace.write')).toHaveLength(1))
    expect(screen.getByText('成功')).toBeTruthy()
    expect(screen.getByText('不明')).toBeTruthy()
    expect(screen.getByText('connector-b')).toBeTruthy()
    expect(screen.getByText('hub-connector')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/conversations/c-1/remote-actions?limit=30')
    expect(screen.queryByText(/对话执行机|生成配对码/)).toBeNull()
    expect(screen.queryByTestId('connector-onboarding')).toBeNull()
  })

  it('无动作时显示统一台账空态，不再排除中枢机器动作', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ actions: [] }))))
    render(<ExecutionMachineModal conversationId="c-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('本对话暂无动作记录')).toBeTruthy())
  })

  it('401 显示登录过期错误，不呈现误导空态', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401))))
    render(<ExecutionMachineModal conversationId="c-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('登录已过期'))
    expect(screen.queryByText('本对话暂无动作记录')).toBeNull()
  })

  it('5xx 显示真实状态码，刷新可恢复', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ error: 'boom' }, 500)))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ actions: actionsFixture })))
    vi.stubGlobal('fetch', fetchMock)
    render(<ExecutionMachineModal conversationId="c-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('HTTP 500'))

    fireEvent.click(screen.getByTitle('刷新动作状态'))
    await waitFor(() => expect(screen.getByText('成功')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
