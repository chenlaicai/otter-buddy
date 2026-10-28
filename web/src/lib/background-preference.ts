import { deleteBackground, saveBackground } from '../api/client'
import { identityHeaders, withIdentity } from '../api/identity'
import { setBackgroundSnapshot } from './background-preference-store'

export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024
const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
let operationGeneration = 0

export class BackgroundPreferenceError extends Error {}

function clearAppliedBackground() {
  const root = document.documentElement
  root.style.removeProperty('--custom-bg-image')
  root.removeAttribute('data-custom-bg')
}

function applyDecodedBackground(url: string) {
  // Why: URL 只由本应用受控 API 产生，不用用户输入拼 HTML/CSS。
  document.documentElement.style.setProperty('--custom-bg-image', `url("${url}")`)
  document.documentElement.setAttribute('data-custom-bg', 'true')
}

function decodeImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve()
      else reject(new BackgroundPreferenceError('图片内容为空，请换一张图片'))
    }
    image.onerror = () => reject(new BackgroundPreferenceError('图片已损坏或无法读取，请换一张图片'))
    image.src = url
  })
}

export async function restoreBackgroundPreference(): Promise<void> {
  const generation = ++operationGeneration
  try {
    const response = await fetch(withIdentity('/api/settings/background'), {
      headers: identityHeaders(),
      cache: 'no-store',
    })
    if (response.status === 404) {
      clearAppliedBackground()
      setBackgroundSnapshot(null)
      return
    }
    if (!response.ok) throw new Error('background fetch failed')
    const version = response.headers.get('ETag')?.replaceAll('"', '') ?? Date.now().toString()
    const url = withIdentity(`/api/settings/background?v=${encodeURIComponent(version)}`)
    await decodeImage(url)
    // Why: 慢请求不得覆盖较新的恢复或用户选择。
    if (generation !== operationGeneration) return
    applyDecodedBackground(url)
    setBackgroundSnapshot(url)
  } catch {
    // 服务不可用/资产损坏时保留默认画布，不把偏好悄悄存回浏览器。
    if (generation === operationGeneration) {
      clearAppliedBackground()
      setBackgroundSnapshot(null)
    }
  }
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new BackgroundPreferenceError('图片读取失败，请重新选择'))
    }
    reader.onerror = () => reject(new BackgroundPreferenceError('图片读取失败，请重新选择'))
    reader.onabort = () => reject(new BackgroundPreferenceError('图片读取已取消，请重新选择'))
    reader.readAsDataURL(file)
  })
}

export async function selectBackgroundImage(file: File): Promise<void> {
  const generation = ++operationGeneration
  if (!ACCEPTED_MIME_TYPES.has(file.type)) {
    throw new BackgroundPreferenceError('仅支持 JPG、PNG 或 WebP 图片')
  }
  if (file.size > MAX_BACKGROUND_BYTES) {
    throw new BackgroundPreferenceError('图片不能超过 8 MB')
  }

  const dataUrl = await readFile(file)
  await decodeImage(dataUrl)
  if (generation !== operationGeneration) return
  const { url } = await saveBackground(dataUrl)
  if (generation !== operationGeneration) return

  // Why: 只有服务端原子落盘成功才切换；版本 URL 让刷新/重开浏览器读取同一资产。
  const persistentUrl = withIdentity(url)
  applyDecodedBackground(persistentUrl)
  setBackgroundSnapshot(persistentUrl)
}

export function resetBackgroundPreference(): { persisted: boolean } {
  // 保留同步形态供设置页卸载与旧测试复位；产品路径使用下方异步 reset。
  operationGeneration += 1
  clearAppliedBackground()
  setBackgroundSnapshot(null)
  return { persisted: true }
}

export async function removeBackgroundPreference(): Promise<void> {
  operationGeneration += 1
  await deleteBackground()
  clearAppliedBackground()
  setBackgroundSnapshot(null)
}
