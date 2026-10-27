// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeBackgroundPreference, resetBackgroundPreference, restoreBackgroundPreference, selectBackgroundImage } from './background-preference'

const saveBackgroundMock = vi.hoisted(() => vi.fn())
const deleteBackgroundMock = vi.hoisted(() => vi.fn())
vi.mock('../api/client', () => ({ saveBackground: saveBackgroundMock, deleteBackground: deleteBackgroundMock }))
vi.mock('../api/identity', () => ({
  identityHeaders: () => ({ 'X-Otter-User-Id': 'web-ui', 'X-Otter-User-Role': 'admin' }),
  withIdentity: (path: string) => `${path}${path.includes('?') ? '&' : '?'}otterUserId=web-ui&otterRole=admin`,
}))

const VALID_PNG = 'data:image/png;base64,iVBORw0KGgo='

function mockImageDecode(succeed = true) {
  return vi.spyOn(window, 'Image').mockImplementation(function MockImage(this: HTMLImageElement) {
    const image = document.createElement('img') as HTMLImageElement
    Object.defineProperty(image, 'naturalWidth', { value: succeed ? 800 : 0 })
    Object.defineProperty(image, 'naturalHeight', { value: succeed ? 600 : 0 })
    Object.defineProperty(image, 'src', {
      set(value: string) {
        image.setAttribute('src', value)
        queueMicrotask(() => succeed ? image.onload?.(new Event('load')) : image.onerror?.(new Event('error')))
      },
    })
    return image
  } as unknown as new () => HTMLImageElement)
}

function mockFileReader(result: string | null, mode: 'load' | 'error' | 'abort' = 'load') {
  return vi.spyOn(window, 'FileReader').mockImplementation(function MockFileReader(this: FileReader) {
    Object.defineProperties(this, {
      result: { configurable: true, value: result },
      onload: { configurable: true, writable: true, value: null },
      onerror: { configurable: true, writable: true, value: null },
      onabort: { configurable: true, writable: true, value: null },
      readAsDataURL: {
        configurable: true,
        value() {
          queueMicrotask(() => {
            const event = new ProgressEvent(mode) as ProgressEvent<FileReader>
            if (mode === 'load') this.onload?.(event)
            else if (mode === 'error') this.onerror?.(event)
            else this.onabort?.(event)
          })
        },
      },
    })
    return this
  } as unknown as new () => FileReader)
}

function pngFile() { return new File(['image'], 'landscape.png', { type: 'image/png' }) }
function backgroundResponse(etag = '"v1"') {
  // Uint8Array 兼容 CI 的 undici Response；jsdom Blob 缺 stream() 会触发 duck-typing 失败。
  return new Response(new Uint8Array([105, 109, 97, 103, 101]), { status: 200, headers: { ETag: etag } })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetBackgroundPreference()
  mockImageDecode()
  mockFileReader(VALID_PNG)
  saveBackgroundMock.mockResolvedValue({ url: '/api/settings/background?v=2' })
  deleteBackgroundMock.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(backgroundResponse()))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetBackgroundPreference()
})

describe('启动目录背景偏好', () => {
  it('合法图片经服务端保存成功后应用版本 URL，不写 localStorage', async () => {
    await selectBackgroundImage(pngFile())

    expect(saveBackgroundMock).toHaveBeenCalledWith(VALID_PNG)
    expect(document.documentElement.style.getPropertyValue('--custom-bg-image')).toContain('/api/settings/background?v=2')
    expect(document.documentElement.getAttribute('data-custom-bg')).toBe('true')
    expect(localStorage.getItem('otter-background-image-v1')).toBeNull()
  })

  it.each(['image/gif', 'image/svg+xml', 'text/plain'])('拒绝 %s，不上传', async type => {
    await expect(selectBackgroundImage(new File(['x'], 'x', { type }))).rejects.toThrow('仅支持')
    expect(saveBackgroundMock).not.toHaveBeenCalled()
  })

  it('超过 8 MiB 原图直接拒绝', async () => {
    const file = pngFile()
    Object.defineProperty(file, 'size', { value: 8 * 1024 * 1024 + 1 })
    await expect(selectBackgroundImage(file)).rejects.toThrow('不能超过 8 MB')
    expect(saveBackgroundMock).not.toHaveBeenCalled()
  })

  it.each([['error', '图片读取失败'], ['abort', '图片读取已取消']] as const)('FileReader %s 不上传', async (mode, message) => {
    mockFileReader(null, mode)
    await expect(selectBackgroundImage(pngFile())).rejects.toThrow(message)
    expect(saveBackgroundMock).not.toHaveBeenCalled()
  })

  it('浏览器解码失败不上传', async () => {
    mockImageDecode(false)
    await expect(selectBackgroundImage(pngFile())).rejects.toThrow('损坏或无法读取')
    expect(saveBackgroundMock).not.toHaveBeenCalled()
  })

  it('服务端保存失败保留原背景并透传真实错误', async () => {
    saveBackgroundMock.mockRejectedValue(new Error('磁盘空间不足'))
    await expect(selectBackgroundImage(pngFile())).rejects.toThrow('磁盘空间不足')
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
  })

  it('启动从应用目录读取背景，重开浏览器不依赖 localStorage', async () => {
    await restoreBackgroundPreference()

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/settings/background'), expect.objectContaining({ cache: 'no-store' }))
    expect(document.documentElement.style.getPropertyValue('--custom-bg-image')).toContain('v=v1')
    expect(document.documentElement.getAttribute('data-custom-bg')).toBe('true')
  })

  it('启动无配置 404 使用默认画布', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }))
    await restoreBackgroundPreference()
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
  })

  it('启动服务失败或坏图回退默认且不抛出', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    await expect(restoreBackgroundPreference()).resolves.toBeUndefined()
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)

    vi.mocked(fetch).mockResolvedValue(backgroundResponse())
    mockImageDecode(false)
    await expect(restoreBackgroundPreference()).resolves.toBeUndefined()
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
  })

  it('启动读取中保存新图，过期恢复不得覆盖新图', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
    const restoring = restoreBackgroundPreference()
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'))
    saveBackgroundMock.mockResolvedValue({ url: '/api/settings/background?v=new' })
    await selectBackgroundImage(pngFile())
    resolveFetch?.(backgroundResponse('"old"'))
    await restoring

    expect(document.documentElement.style.getPropertyValue('--custom-bg-image')).toContain('v=new')
  })

  it('连续选图只有最后一次服务端结果生效', async () => {
    let resolveFirst: ((value: { url: string }) => void) | undefined
    saveBackgroundMock.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
    const first = selectBackgroundImage(pngFile())
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'))
    const second = selectBackgroundImage(pngFile())
    await second
    resolveFirst?.({ url: '/api/settings/background?v=old' })
    await first
    expect(document.documentElement.style.getPropertyValue('--custom-bg-image')).toContain('v=2')
  })

  it('选图保存中恢复默认，过期保存不得随后应用', async () => {
    let resolveSave: ((value: { url: string }) => void) | undefined
    saveBackgroundMock.mockImplementation(() => new Promise(resolve => { resolveSave = resolve }))
    const selecting = selectBackgroundImage(pngFile())
    await vi.waitFor(() => expect(resolveSave).toBeTypeOf('function'))
    await removeBackgroundPreference()
    resolveSave?.({ url: '/api/settings/background?v=old' })
    await selecting
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
  })

  it('恢复默认删除应用目录资产；失败时保留当前背景并报错', async () => {
    await selectBackgroundImage(pngFile())
    await removeBackgroundPreference()
    expect(deleteBackgroundMock).toHaveBeenCalled()
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)

    await selectBackgroundImage(pngFile())
    deleteBackgroundMock.mockRejectedValue(new Error('permission denied'))
    await expect(removeBackgroundPreference()).rejects.toThrow('permission denied')
    expect(document.documentElement.getAttribute('data-custom-bg')).toBe('true')
  })
})
