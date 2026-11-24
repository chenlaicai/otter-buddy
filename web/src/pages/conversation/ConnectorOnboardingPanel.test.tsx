// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConnectorOnboardingPanel } from './ConnectorOnboardingPanel'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function issuedFixture() {
  return { code: 'ABCD2345', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
}

describe('ConnectorOnboardingPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('签发后显示一次性码、有效期、当前 origin 与开发态首启命令，可复制', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(issuedFixture(), 201))))
    render(<ConnectorOnboardingPanel />)

    expect(screen.getByText(/开发态：下载的是 npm CLI tarball/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '生成配对码' }))
    await waitFor(() => expect(screen.getByTestId('pairing-code').textContent).toBe('ABCD2345'))
    expect(screen.getByTestId('hub-url').textContent).toBe(window.location.origin)
    expect(screen.getByText(/10 分钟内单次有效/)).toBeTruthy()
    expect(screen.getByTestId('pairing-command').textContent).toContain(`--hub ${window.location.origin} --pair ABCD2345`)

    fireEvent.click(screen.getByRole('button', { name: '复制首启命令' }))
    await waitFor(() => expect(String(writeText.mock.calls[0]?.[0])).toContain('--pair ABCD2345'))
    expect(screen.getByText('已复制首启命令')).toBeTruthy()
  })

  it('下载使用同源登录态并生成带中枢版本的 tarball 文件', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('tarball-bytes', {
      status: 200,
      headers: { 'X-Otter-Connector-Version': '0.1.0' },
    })))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:connector-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ConnectorOnboardingPanel />)

    fireEvent.click(screen.getByTestId('download-connector'))
    await waitFor(() => expect(screen.getByText('已下载')).toBeTruthy())
    expect(fetchMock.mock.calls[0]).toEqual(['/api/connector/download', { credentials: 'same-origin' }])
    expect(click).toHaveBeenCalled()
    expect(vi.mocked(URL.revokeObjectURL).mock.calls[0]).toEqual(['blob:connector-test'])
  })

  it('签发 403 与下载缺包 503 都显示真实错误，不伪称成功', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('pairing-codes')) return Promise.resolve(jsonResponse({ error: 'forbidden' }, 403))
      return Promise.resolve(jsonResponse({ error: 'Connector CLI package is unavailable; rebuild the hub before downloading' }, 503))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ConnectorOnboardingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '生成配对码' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('owner/admin'))
    expect(screen.queryByTestId('pairing-details')).toBeNull()

    fireEvent.click(screen.getByTestId('download-connector'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('package is unavailable'))
    expect(screen.queryByText('已下载')).toBeNull()
  })

  it('签发 401 显示登录过期，旧配对码在重新签发时立即撤下', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(jsonResponse(issuedFixture(), 201)))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)))
    vi.stubGlobal('fetch', fetchMock)
    render(<ConnectorOnboardingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '生成配对码' }))
    await waitFor(() => expect(screen.getByTestId('pairing-code')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '重新签发' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('登录已过期'))
    expect(screen.queryByTestId('pairing-code')).toBeNull()
  })
})
