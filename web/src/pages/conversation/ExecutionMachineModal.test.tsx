// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ExecutionMachineModal } from './ExecutionMachineModal'

/**
 * F20261118exstt（#1868 阶段 5 PR-B）：执行机选择器 + 远程动作状态组件测试。
 */

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)))
}

describe('ExecutionMachineModal（阶段 5 PR-B）', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function standardMock(overrides?: {
    machines?: unknown
    current?: string | null
    actions?: unknown
  }) {
    return stubFetch((url, init) => {
      if (url === '/api/execution-machines') {
        return jsonResponse({ machines: overrides?.machines ?? [
          { id: 'local', name: '本机' },
          { id: 'connector-b', name: 'B 机', online: true, lastSeenAt: '2026-11-18T06:00:00Z' },
          { id: 'connector-c', name: 'C 机', online: false, lastSeenAt: '2026-11-17T00:00:00Z' },
        ], currentMachineId: 'local' })
      }
      if (url.includes('/execution-machine') && (!init || init.method === undefined || init.method === 'GET')) {
        return jsonResponse({ machineId: overrides?.current ?? null })
      }
      if (url.includes('/remote-actions')) {
        return jsonResponse({ actions: overrides?.actions ?? [
          { actionId: 'a-1', deviceId: 'connector-b', actionType: 'workspace.write', status: 'succeeded', error: null, createdAt: '2026-11-18T06:00:00Z', settledAt: '2026-11-18T06:00:01Z' },
          { actionId: 'a-2', deviceId: 'connector-b', actionType: 'workspace.write', status: 'unknown', error: 'timeout after 30000ms', createdAt: '2026-11-18T05:00:00Z', settledAt: null },
        ] })
      }
      return jsonResponse({ error: 'not found' }, 404)
    })
  }

  it('全量设备列表 + 在线状态点 + 当前回显（null=本机默认选中）', async () => {
    const fetchMock = standardMock()
    vi.stubGlobal('fetch', fetchMock)
    render(<ExecutionMachineModal conversationId="c-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('machine-option-connector-b')).toBeTruthy())
    expect(screen.getByTestId('machine-option-local').textContent).toContain('本机')
    expect(screen.getByTestId('machine-option-local').textContent).toContain('当前') // null → local 选中
    expect(screen.getByTestId('machine-option-connector-b').textContent).toContain('在线')
    expect(screen.getByTestId('machine-option-connector-c').textContent).toContain('离线')
    // 远程动作五态列表
    expect(screen.getAllByText('workspace.write').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('成功')).toBeTruthy()
    expect(screen.getByText('不明')).toBeTruthy()
  })

  it('离线设备置灰不可选（重连后可切）', async () => {
    vi.stubGlobal('fetch', standardMock())
    render(<ExecutionMachineModal conversationId="c-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('machine-option-connector-c')).toBeTruthy())
    const offline = screen.getByTestId('machine-option-connector-c') as HTMLButtonElement
    expect(offline.disabled).toBe(true)
  })

  it('切换调用 PUT（选 connector-b）；「本机」选项提交 null（回默认）', async () => {
    const fetchMock = standardMock({ current: 'connector-b' })
    vi.stubGlobal('fetch', fetchMock)
    render(<ExecutionMachineModal conversationId="c-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('machine-option-connector-b').textContent).toContain('当前'))

    // 切回本机 → PUT machineId: null
    fireEvent.click(screen.getByTestId('machine-option-local'))
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(c => c[1]?.method === 'PUT')
      expect(put?.[0]).toContain('/api/conversations/c-1/execution-machine')
      expect(JSON.parse(String(put?.[1]?.body)).machineId).toBeNull()
    })
  })

  it('切换失败（400 目标未注册）显示错误不落选中态', async () => {
    const fetchMock = standardMock()
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return jsonResponse({ error: 'machine not registered: ghost（设备未上线或未配对——目标必须当前在册；离线设备重连后可切）' }, 400)
      return Promise.resolve(standardMock()(url, init))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ExecutionMachineModal conversationId="c-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('machine-option-connector-b')).toBeTruthy())
    fireEvent.click(screen.getByTestId('machine-option-connector-b'))
    await waitFor(() => expect(screen.getByText(/machine not registered/)).toBeTruthy())
    // 选中态未漂移（仍是 null→local）
    expect(screen.getByTestId('machine-option-local').textContent).toContain('当前')
  })

  it('无远程动作时空态文案（本机动作不在此列）', async () => {
    vi.stubGlobal('fetch', standardMock({ actions: [] }))
    render(<ExecutionMachineModal conversationId="c-1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/暂无远程动作记录/)).toBeTruthy())
  })
})
