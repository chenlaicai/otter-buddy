import { deleteBackground, saveBackground } from '../api/client'
import { identityHeaders, withIdentity } from '../api/identity'
import { setBackgroundSnapshot } from './background-preference-store'

export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024
const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
let operationGeneration = 0

export class BackgroundPreferenceError extends Error {}

/** F20261102glmtr v3.0：中性纱 fallback——主色提取前/失败时薄纱用（与 globals.css var fallback 同值） */
const NEUTRAL_TINT_RGB = '250, 247, 238'

function clearAppliedBackground() {
  const root = document.documentElement
  root.style.removeProperty('--custom-bg-image')
  root.removeAttribute('data-custom-bg')
  root.style.removeProperty('--canvas-tint-rgb')
}

function applyDecodedBackground(url: string) {
  // Why: URL 只由本应用受控 API 产生，不用用户输入拼 HTML/CSS。
  const root = document.documentElement
  root.style.setProperty('--custom-bg-image', `url("${url}")`)
  root.setAttribute('data-custom-bg', 'true')
  // F20261102glmtr：同步落中性纱兜底（CSS var fallback 双保险），再异步换成真主色——
  // 薄纱任何窗口期都不会让背景图失效（var 未定义→整条多层声明 invalid 的红线）。
  root.style.setProperty('--canvas-tint-rgb', NEUTRAL_TINT_RGB)
  extractDominantTint(url, root)
}

/**
 * F20261102glmtr：Mica 式主色提取——离屏 canvas 降采样取平均色，向 stone 系中和
 * （降饱和+亮度锥制）后写 --canvas-tint-rgb，供 globals.css 静态薄纱合成。
 * 一次性计算、纯运行时 CSS var（不落库）；失败静默保留当前值（中性纱）。
 */
function extractDominantTint(url: string, root: HTMLElement): void {
  try {
    const image = new Image()
    image.onload = () => {
      try {
        if (image.naturalWidth === 0 || image.naturalHeight === 0) return
        const canvas = document.createElement('canvas')
        canvas.width = 8
        canvas.height = 8
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(image, 0, 0, 8, 8)
        const { data } = ctx.getImageData(0, 0, 8, 8)
        let r = 0
        let g = 0
        let b = 0
        const px = data.length / 4
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
        }
        r = Math.round(r / px)
        g = Math.round(g / px)
        b = Math.round(b / px)
        // 向 stone 系中和：降饱和（对白锚点插值）+亮度锥制在浅色区间，保证面板文字对比度
        const desat = (v: number) => Math.round(v * 0.45 + 250 * 0.55)
        const clampLight = (v: number) => Math.min(250, Math.max(210, desat(v)))
        root.style.setProperty('--canvas-tint-rgb', `${clampLight(r)}, ${clampLight(g)}, ${clampLight(b)}`)
      } catch {
        // canvas 被污染/CORS 等异常：保留中性纱，薄纱不中断
      }
    }
    image.onerror = () => {
      // 提取失败保留中性纱
    }
    image.src = url
  } catch {
    // 任何同步异常保留中性纱
  }
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
