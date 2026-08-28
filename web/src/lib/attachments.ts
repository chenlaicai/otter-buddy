/**
 * 多模态 Phase 1 附件工具：展示格式化 + 上传前校验。
 *
 * 校验白名单与后端 upload-validation.ts 对齐（前端拒一次省一趟网络；
 * 后端仍是真相源——前端过但后端拒的（如 magic bytes 不符）由后端 400 兜底）。
 */

/** image 扩展名白名单（与后端 IMAGE_MIME_WHITELIST 一致；SVG 明确排除——XSS 向量） */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

/** document 扩展名白名单（与后端 DOCUMENT_EXTENSION_MAP 一致——纯文本类，可注入 LLM） */
export const DOCUMENT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.json']

/** 文件选择器 accept 属性（两类白名单合并） */
export const ATTACHMENT_ACCEPT = [...IMAGE_EXTENSIONS, ...DOCUMENT_EXTENSIONS].join(',')

/** 上传/携带限制（与后端一致：每轮 ≤2 图、单次上传 ≤5 文件、图 10MB/文档 20MB） */
export const MAX_IMAGES_PER_SEND = 2
export const MAX_FILES_PER_UPLOAD = 5
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

export type AttachmentKind = 'image' | 'document'

export interface RejectedFile {
  name: string
  reason: string
}

/** 按扩展名判定附件类型（白名单外返回 null） */
export function classifyByExtension(name: string): AttachmentKind | null {
  const lower = name.toLowerCase()
  if (IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'image'
  if (DOCUMENT_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'document'
  return null
}

/** 上传前校验：类型白名单 + 大小限制。返回 [通过, 拒绝原因] */
export function validateFile(file: File): [boolean, string | null] {
  const kind = classifyByExtension(file.name)
  if (!kind) return [false, `不支持的文件类型（支持：${ATTACHMENT_ACCEPT}）`]
  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
  if (file.size > limit) {
    return [false, `${kind === 'image' ? '图片' : '文档'}超过大小限制（${fmtBytes(limit)}）`]
  }
  return [true, null]
}

/** 批量挑选：白名单+大小校验。返回 [通过文件, 拒绝清单] */
export function pickValidFiles(files: File[]): [File[], RejectedFile[]] {
  const valid: File[] = []
  const rejected: RejectedFile[] = []
  for (const f of files) {
    const [ok, reason] = validateFile(f)
    if (ok) valid.push(f)
    else rejected.push({ name: f.name, reason: reason || '未知原因' })
  }
  return [valid, rejected]
}

/** 字节数人性化（展示用） */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
