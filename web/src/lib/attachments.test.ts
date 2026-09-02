// @vitest-environment jsdom
/**
 * 多模态 Phase 1 前端附件：lib/attachments 校验纯函数测试。
 * 白名单与大小限制和后端 upload-validation.ts / config 默认值对齐——
 * 前端拒一次省一趟网络，但后端仍是真相源。
 */
import { describe, it, expect } from 'vitest'
import {
  classifyByExtension,
  validateFile,
  pickValidFiles,
  fmtBytes,
  ATTACHMENT_ACCEPT,
  MAX_IMAGE_BYTES,
  MAX_DOCUMENT_BYTES,
} from './attachments'

function file(name: string, size: number, type = 'application/octet-stream'): File {
  return new File([new ArrayBuffer(size)], name, { type })
}

describe('classifyByExtension', () => {
  it('图片扩展名识别为 image（含大小写不敏感）', () => {
    expect(classifyByExtension('photo.PNG')).toBe('image')
    expect(classifyByExtension('photo.jpg')).toBe('image')
    expect(classifyByExtension('photo.JPEG')).toBe('image')
    expect(classifyByExtension('photo.webp')).toBe('image')
    expect(classifyByExtension('photo.gif')).toBe('image')
  })

  it('文档扩展名识别为 document', () => {
    expect(classifyByExtension('notes.txt')).toBe('document')
    expect(classifyByExtension('readme.md')).toBe('document')
    expect(classifyByExtension('data.markdown')).toBe('document')
    expect(classifyByExtension('sheet.csv')).toBe('document')
    expect(classifyByExtension('config.json')).toBe('document')
  })

  it('SVG 明确排除（XSS 向量，与后端白名单一致）', () => {
    expect(classifyByExtension('evil.svg')).toBeNull()
  })

  it('白名单外返回 null', () => {
    expect(classifyByExtension('archive.zip')).toBeNull()
    expect(classifyByExtension('app.exe')).toBeNull()
    expect(classifyByExtension('noext')).toBeNull()
  })

  it('#608：pdf/wav/mp3/mp4 加入白名单', () => {
    expect(classifyByExtension('doc.pdf')).toBe('document')
    expect(classifyByExtension('rec.wav')).toBe('audio')
    expect(classifyByExtension('song.mp3')).toBe('audio')
    expect(classifyByExtension('movie.mp4')).toBe('video')
  })

  it('accept 属性不含 svg', () => {
    expect(ATTACHMENT_ACCEPT).not.toContain('.svg')
  })
})

describe('validateFile', () => {
  it('图片超过 10MB 拒绝（提示含限制值）', () => {
    const [ok, reason] = validateFile(file('big.png', MAX_IMAGE_BYTES + 1, 'image/png'))
    expect(ok).toBe(false)
    expect(reason).toContain('10.0MB')
  })

  it('图片恰好 10MB 通过（边界含）', () => {
    const [ok] = validateFile(file('edge.png', MAX_IMAGE_BYTES, 'image/png'))
    expect(ok).toBe(true)
  })

  it('文档超过 20MB 拒绝', () => {
    const [ok, reason] = validateFile(file('big.txt', MAX_DOCUMENT_BYTES + 1, 'text/plain'))
    expect(ok).toBe(false)
    expect(reason).toContain('20.0MB')
  })

  it('类型不在白名单拒绝（提示含支持列表）', () => {
    const [ok, reason] = validateFile(file('setup.exe', 100, 'application/x-msdownload'))
    expect(ok).toBe(false)
    expect(reason).toContain('不支持')
  })

  it('#608：mp4 在白名单通过', () => {
    const [ok] = validateFile(file('movie.mp4', 100, 'video/mp4'))
    expect(ok).toBe(true)
  })
})

describe('pickValidFiles', () => {
  it('混合批次按文件拆分通过/拒绝（单个拒绝不阻塞整批）', () => {
    const [valid, rejected] = pickValidFiles([
      file('a.png', 1000, 'image/png'),
      file('b.exe', 100),
      file('c.md', 2000, 'text/markdown'),
    ])
    expect(valid.map(f => f.name)).toEqual(['a.png', 'c.md'])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].name).toBe('b.exe')
  })

  it('全拒批次返回空数组', () => {
    const [valid, rejected] = pickValidFiles([file('a.zip', 10), file('b.rar', 10)])
    expect(valid).toHaveLength(0)
    expect(rejected).toHaveLength(2)
  })
})

describe('fmtBytes', () => {
  it('B/KB/MB 三档人性化', () => {
    expect(fmtBytes(512)).toBe('512B')
    expect(fmtBytes(2048)).toBe('2.0KB')
    expect(fmtBytes(10 * 1024 * 1024)).toBe('10.0MB')
  })
})
