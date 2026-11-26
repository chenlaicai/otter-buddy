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

    expect(screen.getByText(/内嵌 Node 运行时，目标电脑无需安装 Node\/npm/)).toBeTruthy()
    expect(screen.getByText(/开发态：需要 Node\.js 22\+、npm 和命令行/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '生成配对码' }))
    await waitFor(() => expect(screen.getByTestId('pairing-code').textContent).toBe('ABCD2345'))
    expect(screen.getByTestId('hub-url').textContent).toBe(window.location.origin)
    expect(screen.getByText(/10 分钟内单次有效/)).toBeTruthy()
    expect(screen.getByText('此前已生成但未核销的码在各自到期前仍可使用；每码只能核销一次。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '生成新码' })).toBeTruthy()
    expect(screen.getByTestId('pairing-command').textContent).toContain(`--hub ${window.location.origin} --pair ABCD2345`)
    // 签发后出现引导文件入口与使用说明
    expect(screen.getByTestId('download-bootstrap')).toBeTruthy()
    expect(screen.getByText(/含当前配对码与中枢地址（与配对码同效、同样一次性）/)).toBeTruthy()

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

  it('签发前不出现引导文件入口；app 安装包入口始终可见且带未签名标注', () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<ConnectorOnboardingPanel />)
    expect(screen.getByTestId('download-connector-app')).toBeTruthy()
    expect(screen.queryByTestId('download-bootstrap')).toBeNull()
    expect(screen.getByText(/开发态未签名：首次打开可能被 macOS 拦截/)).toBeTruthy()
  })

  it('app 安装包下载走同源登录态并按中枢版本命名 zip', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('app-zip-bytes', {
      status: 200,
      headers: { 'X-Otter-Connector-Version': '0.1.0' },
    })))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:app-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download) })
    render(<ConnectorOnboardingPanel />)

    fireEvent.click(screen.getByTestId('download-connector-app'))
    await waitFor(() => expect(screen.getByText('已下载')).toBeTruthy())
    expect(fetchMock.mock.calls[0]).toEqual(['/api/connector/download/app', { credentials: 'same-origin' }])
    expect(downloads[0]).toBe('otter-connector-0.1.0.zip')
  })

  it('引导文件下载带签发码 POST，保存固定名 bootstrap.json', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('pairing-codes')) return Promise.resolve(jsonResponse(issuedFixture(), 201))
      expect(url).toBe('/api/connector/download/bootstrap')
      expect(JSON.parse(String(init?.body))).toEqual({ code: 'ABCD2345' })
      return Promise.resolve(jsonResponse({ hub: 'http://localhost:3000', code: 'ABCD2345', expiresAt: '2026-11-24T12:00:00.000Z' }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bootstrap-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download) })
    render(<ConnectorOnboardingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '生成配对码' }))
    await waitFor(() => expect(screen.getByTestId('download-bootstrap')).toBeTruthy())
    fireEvent.click(screen.getByTestId('download-bootstrap'))
    await waitFor(() => expect(screen.getByText('已下载')).toBeTruthy())
    expect(downloads).toEqual(['otter-connector-bootstrap.json'])
  })

  it('app 安装包缺包 503 明确报错，不伪装成功', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('download/app')) {
        return Promise.resolve(jsonResponse({ error: 'Connector app package is unavailable; rebuild the hub before downloading', code: 'connector_app_package_missing' }, 503))
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ConnectorOnboardingPanel />)

    fireEvent.click(screen.getByTestId('download-connector-app'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('app package is unavailable'))
    expect(screen.queryByText('已下载')).toBeNull()
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

  it('生成新码失败时显示 401 并撤下当前旧码，但不暗示服务端撤销旧码', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(jsonResponse(issuedFixture(), 201)))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)))
    vi.stubGlobal('fetch', fetchMock)
    render(<ConnectorOnboardingPanel />)

    fireEvent.click(screen.getByRole('button', { name: '生成配对码' }))
    await waitFor(() => expect(screen.getByTestId('pairing-code')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '生成新码' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('登录已过期'))
    expect(screen.queryByTestId('pairing-code')).toBeNull()
  })
})
