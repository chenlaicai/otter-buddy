// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TopBar } from './TopBar'

describe('TopBar 执行机 badge（#1868 守卫）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('登录后显示当前执行机名称', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ machines: [{ id: 'local', name: '本机' }], currentMachineId: 'local' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    render(<MemoryRouter><TopBar /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('execution-machine').textContent).toContain('本机'))
  })

  it('执行机数据不可得时静默隐藏 badge（不阻塞布局）', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<MemoryRouter><TopBar /></MemoryRouter>)
    expect(fetchMock).toHaveBeenCalledWith('/api/execution-machines', { credentials: 'same-origin' })
    expect(container.querySelector('[data-testid="execution-machine"]')).toBeNull()
  })
})