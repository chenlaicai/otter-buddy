import { BACKGROUND_STORAGE_KEY, notifyBackgroundPreferenceChanged } from './background-preference-store'

export const MAX_BACKGROUND_DATA_URL_LENGTH = 4_500_000

const DATA_URL_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]*={0,2}$/
const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
let selectionGeneration = 0

export class BackgroundPreferenceError extends Error {}

function clearAppliedBackground() {
  const root = document.documentElement
  root.style.removeProperty('--custom-bg-image')
  root.removeAttribute('data-custom-bg')
}

function applyDecodedBackground(dataUrl: string) {
  // Why: CSS 变量只接收经过完整字符白名单与浏览器解码的图片，不拼接 HTML。
  document.documentElement.style.setProperty('--custom-bg-image', `url("${dataUrl}")`)
  document.documentElement.setAttribute('data-custom-bg', 'true')
}

function validateDataUrl(dataUrl: string) {
  if (!DATA_URL_PATTERN.test(dataUrl)) {
    throw new BackgroundPreferenceError('图片数据无效，请重新选择 JPG、PNG 或 WebP 图片')
  }
  if (dataUrl.length > MAX_BACKGROUND_DATA_URL_LENGTH) {
    throw new BackgroundPreferenceError('图片编码后不能超过 4.5 MB（通常约 3.3 MB 原图）')
  }
}

function decodeImage(dataUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve()
      else reject(new BackgroundPreferenceError('图片内容为空，请换一张图片'))
    }
    image.onerror = () => reject(new BackgroundPreferenceError('图片已损坏或无法解码，请换一张图片'))
    image.src = dataUrl
  })
}

function readStoredBackground() {
  try {
    return localStorage.getItem(BACKGROUND_STORAGE_KEY)
  } catch {
    return null
  }
}

function discardInvalidStoredBackground() {
  clearAppliedBackground()
  try { localStorage.removeItem(BACKGROUND_STORAGE_KEY) } catch { /* 存储不可用时仍保留默认画布 */ }
  notifyBackgroundPreferenceChanged()
}

export async function restoreBackgroundPreference(): Promise<void> {
  const dataUrl = readStoredBackground()
  if (!dataUrl) {
    clearAppliedBackground()
    return
  }

  try {
    validateDataUrl(dataUrl)
    await decodeImage(dataUrl)
    // Why: 解码期间用户可能已换图或恢复默认，过期恢复不得覆盖更新后的选择。
    if (readStoredBackground() !== dataUrl) return
    applyDecodedBackground(dataUrl)
  } catch {
    if (readStoredBackground() === dataUrl) discardInvalidStoredBackground()
  }
}

export async function selectBackgroundImage(file: File): Promise<void> {
  const generation = ++selectionGeneration
  if (!ACCEPTED_MIME_TYPES.has(file.type)) {
    throw new BackgroundPreferenceError('仅支持 JPG、PNG 或 WebP 图片')
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new BackgroundPreferenceError('图片读取失败，请重新选择'))
    }
    reader.onerror = () => reject(new BackgroundPreferenceError('图片读取失败，请重新选择'))
    reader.onabort = () => reject(new BackgroundPreferenceError('图片读取已取消，请重新选择'))
    reader.readAsDataURL(file)
  })

  validateDataUrl(dataUrl)
  await decodeImage(dataUrl)
  // Why: 防护属于模块而非按钮 disabled；过期选择/恢复默认后不得覆盖最后一次操作。
  if (generation !== selectionGeneration) return

  // Why: 先持久化成功再切换画布，配额失败时旧背景与旧偏好保持一致。
  try {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, dataUrl)
  } catch {
    throw new BackgroundPreferenceError('浏览器本地存储空间不足，请换更小的图片')
  }
  applyDecodedBackground(dataUrl)
  notifyBackgroundPreferenceChanged()
}

export function resetBackgroundPreference(): { persisted: boolean } {
  selectionGeneration += 1
  clearAppliedBackground()
  let persisted = true
  try { localStorage.removeItem(BACKGROUND_STORAGE_KEY) } catch { persisted = false }
  notifyBackgroundPreferenceChanged()
  return { persisted }
}
