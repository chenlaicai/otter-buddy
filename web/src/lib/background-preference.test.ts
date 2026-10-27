// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_BACKGROUND_DATA_URL_LENGTH,
  resetBackgroundPreference,
  restoreBackgroundPreference,
  selectBackgroundImage,
} from './background-preference'
import { BACKGROUND_STORAGE_KEY, subscribeBackgroundPreference } from './background-preference-store'

const VALID_PNG = 'data:image/png;base64,iVBORw0KGgo='

function mockImageDecode(succeed = true) {
  return vi.spyOn(window, 'Image').mockImplementation(function MockImage(this: HTMLImageElement) {
    const image = document.createElement('img') as HTMLImageElement
    Object.defineProperty(image, 'naturalWidth', { value: succeed ? 800 : 0 })
    Object.defineProperty(image, 'naturalHeight', { value: succeed ? 600 : 0 })
    Object.defineProperty(image, 'src', {
      set(value: string) {
        image.setAttribute('src', value)
        queueMicrotask(() => {
          if (succeed) image.onload?.(new Event('load'))
          else image.onerror?.(new Event('error'))
        })
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

function pngFile() {
  return new File(['image'], 'landscape.png', { type: 'image/png' })
}

beforeEach(() => {
  localStorage.clear()
  resetBackgroundPreference()
  mockImageDecode()
  mockFileReader(VALID_PNG)
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  resetBackgroundPreference()
})

describe('自定义背景偏好', () => {
  it('连续选图时只有最后选择可生效，不依赖按钮禁用', async () => {
    const first = 'data:image/png;base64,Zmlyc3Q='
    const second = 'data:image/png;base64,c2Vjb25k'
    const finishDecodes: Array<() => void> = []
    mockFileReader(first)
    vi.spyOn(window, 'Image').mockImplementation(function MockImage(this: HTMLImageElement) {
      const image = document.createElement('img') as HTMLImageElement
      Object.defineProperty(image, 'naturalWidth', { value: 800 })
      Object.defineProperty(image, 'naturalHeight', { value: 600 })
      Object.defineProperty(image, 'src', {
        set(value: string) {
          image.setAttribute('src', value)
          finishDecodes.push(() => image.onload?.(new Event('load')))
        },
      })
      return image
    } as unknown as new () => HTMLImageElement)

    const firstSelection = selectBackgroundImage(pngFile())
    mockFileReader(second)
    const secondSelection = selectBackgroundImage(pngFile())
    await vi.waitFor(() => expect(finishDecodes).toHaveLength(2))
    finishDecodes[1]()
    await secondSelection
    finishDecodes[0]()
    await firstSelection

    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBe(second)
    expect(document.documentElement.style.getPropertyValue('--custom-bg-image')).toBe(`url("${second}")`)
  })

  it('选图解码中恢复默认，过期选择不得随后写回', async () => {
    let finishDecode: (() => void) | undefined
    vi.spyOn(window, 'Image').mockImplementation(function MockImage(this: HTMLImageElement) {
      const image = document.createElement('img') as HTMLImageElement
      Object.defineProperty(image, 'naturalWidth', { value: 800 })
      Object.defineProperty(image, 'naturalHeight', { value: 600 })
      Object.defineProperty(image, 'src', {
        set(value: string) {
          image.setAttribute('src', value)
          finishDecode = () => image.onload?.(new Event('load'))
        },
      })
      return image
    } as unknown as new () => HTMLImageElement)

    const selecting = selectBackgroundImage(pngFile())
    await vi.waitFor(() => expect(finishDecode).toBeTypeOf('function'))
    resetBackgroundPreference()
    finishDecode?.()
    await selecting

    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBeNull()
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
  })
  it('合法图片解码成功后持久化并立即应用，同时通知设置页', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeBackgroundPreference(listener)

    await selectBackgroundImage(pngFile())

    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBe(VALID_PNG)
    expect(document.documentElement.style.getPropertyValue('--custom-bg-image')).toBe(`url("${VALID_PNG}")`)
    expect(document.documentElement.getAttribute('data-custom-bg')).toBe('true')
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it.each(['image/gif', 'image/svg+xml', 'text/plain'])('拒绝非目标格式 %s，不改变旧背景', async type => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, VALID_PNG)
    await restoreBackgroundPreference()

    await expect(selectBackgroundImage(new File(['x'], 'x', { type }))).rejects.toThrow('仅支持')

    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBe(VALID_PNG)
    expect(document.documentElement.getAttribute('data-custom-bg')).toBe('true')
  })

  it('按编码后实际长度验收，而不是误用原始文件大小', async () => {
    const tooLarge = `data:image/png;base64,${'A'.repeat(MAX_BACKGROUND_DATA_URL_LENGTH)}`
    mockFileReader(tooLarge)

    await expect(selectBackgroundImage(pngFile())).rejects.toThrow('编码后不能超过 4.5 MB')
    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBeNull()
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
  })

  it.each([
    ['读取失败', 'error' as const, '图片读取失败'],
    ['读取取消', 'abort' as const, '图片读取已取消'],
  ])('%s 时保留旧背景', async (_name, mode, message) => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, VALID_PNG)
    await restoreBackgroundPreference()
    mockFileReader(null, mode)

    await expect(selectBackgroundImage(pngFile())).rejects.toThrow(message)
    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBe(VALID_PNG)
    expect(document.documentElement.getAttribute('data-custom-bg')).toBe('true')
  })

  it('损坏图片解码失败时不写入，也不覆盖旧背景', async () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, VALID_PNG)
    await restoreBackgroundPreference()
    mockImageDecode(false)

    await expect(selectBackgroundImage(pngFile())).rejects.toThrow('损坏或无法解码')
    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBe(VALID_PNG)
    expect(document.documentElement.getAttribute('data-custom-bg')).toBe('true')
  })

  it('本地配额失败时不切换到未保存的新背景', async () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, VALID_PNG)
    await restoreBackgroundPreference()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })

    await expect(selectBackgroundImage(pngFile())).rejects.toThrow('本地存储空间不足')
    expect(document.documentElement.style.getPropertyValue('--custom-bg-image')).toBe(`url("${VALID_PNG}")`)
  })

  it('恢复默认先清画布；删除存储失败也返回可感知结果', async () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, VALID_PNG)
    await restoreBackgroundPreference()
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })

    expect(resetBackgroundPreference()).toEqual({ persisted: false })
    expect(document.documentElement.style.getPropertyValue('--custom-bg-image')).toBe('')
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
  })

  it('启动时恢复合法图片', async () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, VALID_PNG)

    await restoreBackgroundPreference()

    expect(document.documentElement.getAttribute('data-custom-bg')).toBe('true')
    expect(document.documentElement.style.getPropertyValue('--custom-bg-image')).toContain(VALID_PNG)
  })

  it.each([
    ['空值', null],
    ['坏前缀', 'https://example.com/a.png'],
    ['非法 base64 字符', 'data:image/png;base64,");body{display:none}'],
  ])('启动遇到%s回退默认且不抛出', async (_name, stored) => {
    if (stored) localStorage.setItem(BACKGROUND_STORAGE_KEY, stored)

    await expect(restoreBackgroundPreference()).resolves.toBeUndefined()
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBeNull()
  })

  it('启动遇到合法前缀但损坏图片时清坏值并回退默认', async () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, VALID_PNG)
    mockImageDecode(false)

    await restoreBackgroundPreference()

    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBeNull()
  })

  it('启动解码尚未完成时恢复默认，过期图片不得随后盖回来', async () => {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, VALID_PNG)
    let finishDecode: (() => void) | undefined
    vi.spyOn(window, 'Image').mockImplementation(function MockImage(this: HTMLImageElement) {
      const image = document.createElement('img') as HTMLImageElement
      Object.defineProperty(image, 'naturalWidth', { value: 800 })
      Object.defineProperty(image, 'naturalHeight', { value: 600 })
      Object.defineProperty(image, 'src', {
        set(value: string) {
          image.setAttribute('src', value)
          finishDecode = () => image.onload?.(new Event('load'))
        },
      })
      return image
    } as unknown as new () => HTMLImageElement)

    const restoring = restoreBackgroundPreference()
    resetBackgroundPreference()
    finishDecode?.()
    await restoring

    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
    expect(localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBeNull()
  })

  it('localStorage 不可用时启动与恢复都回退默认', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })

    await expect(restoreBackgroundPreference()).resolves.toBeUndefined()
    expect(resetBackgroundPreference()).toEqual({ persisted: false })
    expect(document.documentElement.hasAttribute('data-custom-bg')).toBe(false)
  })
})
