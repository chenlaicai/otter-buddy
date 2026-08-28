// @vitest-environment jsdom
/**
 * 多模态 Phase 1 前端附件：useAttachmentStaging hook 行为测试。
 * 锁定状态机关键行为：占位→服务端替换、上传失败回滚、发送提取与清空、
 * 图片上限兜底（前端与后端 MAX_IMAGES_PER_TURN=2 一致）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAttachmentStaging } from './useAttachmentStaging'
import type { AttachmentDTO } from '@contract/api'

// Why: vi.mock 模块级拦截（而非 spyOn）——hook 内部 import * as api 拿到的是模块命名空间，
// spyOn 拦截不到 hook 闭包内的调用（5 个通过用例恰是未走到 upload 调用路径的）
vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, uploadAttachments: vi.fn() }
})
import * as api from '../../../api/client'
const uploadMock = vi.mocked(api.uploadAttachments)

function dto(id: string, name: string, kind: 'image' | 'document' = 'image'): AttachmentDTO {
  return { id, kind, originalName: name, mimeType: kind === 'image' ? 'image/png' : 'text/plain', sizeBytes: 1234, width: 100, height: 100 }
}

beforeEach(() => {
  uploadMock.mockReset()
})

function pngFile(name = 'a.png'): File {
  return new File([new ArrayBuffer(10)], name, { type: 'image/png' })
}

describe('useAttachmentStaging', () => {
  it('addFiles：占位（uploading）→ 上传完成替换为服务端 DTO', async () => {
    uploadMock.mockResolvedValue({ attachments: [dto('srv-1', 'a.png')] })
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))

    await act(async () => { await result.current.addFiles([pngFile()]) })

    expect(result.current.staged).toHaveLength(1)
    expect(result.current.staged[0].id).toBe('srv-1')
    expect(result.current.staged[0].uploading).toBe(false)
    expect(result.current.staged[0].localPreviewUrl).toBeUndefined()
    expect(uploadMock).toHaveBeenCalledWith('conv-1', expect.any(Array))
  })

  it('上传成功后本地预览 URL 被释放（不留 blob 引用）', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-1')
    uploadMock.mockResolvedValue({ attachments: [dto('srv-1', 'a.png')] })
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))

    await act(async () => { await result.current.addFiles([pngFile()]) })

    expect(createSpy).toHaveBeenCalled()
    expect(revokeSpy).toHaveBeenCalledWith('blob:preview-1')
    revokeSpy.mockRestore()
    createSpy.mockRestore()
  })

  it('上传失败：占位全部移除 + 错误信息可见', async () => {
    uploadMock.mockRejectedValue(new Error('上传失败'))
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))

    await act(async () => { await result.current.addFiles([pngFile()]) })

    expect(result.current.staged).toHaveLength(0)
    expect(result.current.uploadError).toContain('上传失败')
  })

  it('白名单外文件不发起上传且给出拒绝原因', async () => {
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))
    const bad = new File([new ArrayBuffer(10)], 'evil.zip', { type: 'application/zip' })

    await act(async () => { await result.current.addFiles([bad]) })

    expect(uploadMock).not.toHaveBeenCalled()
    expect(result.current.staged).toHaveLength(0)
    expect(result.current.uploadError).toContain('evil.zip')
  })

  it('takeForSend：提取后清空中转区；附件内容为纯数据（无预览 URL/uploading 字段）', async () => {
    uploadMock.mockResolvedValue({ attachments: [dto('srv-1', 'a.png')] })
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))
    await act(async () => { await result.current.addFiles([pngFile()]) })

    let taken: { attachments: AttachmentDTO[] } | undefined
    await act(async () => { taken = result.current.takeForSend() })

    expect(taken!.attachments).toHaveLength(1)
    expect(taken!.attachments[0].id).toBe('srv-1')
    expect(Object.keys(taken!.attachments[0])).not.toContain('localPreviewUrl')
    expect(Object.keys(taken!.attachments[0])).not.toContain('uploading')
    expect(result.current.staged).toHaveLength(0)
  })

  it('takeForSend：图片超每轮 2 张上限兜底拒绝', async () => {
    uploadMock.mockResolvedValue({ attachments: [dto('srv-1', 'a.png'), dto('srv-2', 'b.png'), dto('srv-3', 'c.png')] })
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))
    await act(async () => {
      await result.current.addFiles([pngFile('a.png'), pngFile('b.png'), pngFile('c.png')])
    })
    expect(result.current.staged).toHaveLength(3)

    let taken: { attachments: AttachmentDTO[]; error?: string } | undefined
    await act(async () => { taken = result.current.takeForSend() })

    expect(taken!.attachments).toHaveLength(0)
    expect(taken!.error).toContain('每轮上限')
    // 拒绝后中转区保留（用户可自行移除一张再发）
    expect(result.current.staged).toHaveLength(3)
  })

  it('remove：指定占位可移除（上传完成后用服务端 id 移除）', async () => {
    uploadMock.mockResolvedValue({ attachments: [dto('srv-1', 'a.png')] })
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))
    await act(async () => { await result.current.addFiles([pngFile()]) })

    await act(async () => { result.current.remove('srv-1') })
    expect(result.current.staged).toHaveLength(0)
  })

  it('会话切换清空：clearAll 重置全部状态', async () => {
    uploadMock.mockResolvedValue({ attachments: [dto('srv-1', 'a.png')] })
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))
    await act(async () => { await result.current.addFiles([pngFile()]) })

    act(() => { result.current.clearAll() })
    expect(result.current.staged).toHaveLength(0)
    expect(result.current.uploadError).toBeNull()
  })
})
