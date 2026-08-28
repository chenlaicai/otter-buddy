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
    expect(result.current.uploadError?.message).toContain('上传失败')
  })

  it('白名单外文件不发起上传且给出拒绝原因', async () => {
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))
    const bad = new File([new ArrayBuffer(10)], 'evil.zip', { type: 'application/zip' })

    await act(async () => { await result.current.addFiles([bad]) })

    expect(uploadMock).not.toHaveBeenCalled()
    expect(result.current.staged).toHaveLength(0)
    expect(result.current.uploadError?.message).toContain('evil.zip')
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

  // 发现 1（严重）回归：原实现 clearAll 是死代码——生产链路（ChatView 无 key 不重挂载）
  // 从不触发。必须用同实例 rerender 换 conversationId 断言自动清空（而非只测 clearAll 函数本身）。
  it('会话切换自动清空：同实例 rerender 换 conversationId 后中转区清空（生产链路行为）', async () => {
    uploadMock.mockResolvedValue({ attachments: [dto('srv-1', 'a.png')] })
    const { result, rerender } = renderHook(
      ({ convId }: { convId: string }) => useAttachmentStaging(convId),
      { initialProps: { convId: 'conv-A' } }
    )
    await act(async () => { await result.current.addFiles([pngFile()]) })
    expect(result.current.staged).toHaveLength(1)
    expect(result.current.staged[0].id).toBe('srv-1')

    // 切到会话 B：同实例 rerender（模拟 ChatView 不重挂载的真实路径）
    rerender({ convId: 'conv-B' })

    expect(result.current.staged).toHaveLength(0)
    expect(result.current.uploadError).toBeNull()
  })

  it('会话切换自动清空：上传中的占位（带 blob 预览）被清空且 blob URL 释放', async () => {
    // 不 resolve 的 promise：占位停在上传中状态
    uploadMock.mockReturnValue(new Promise(() => {}) as never)
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending-1')
    const { result, rerender } = renderHook(
      ({ convId }: { convId: string }) => useAttachmentStaging(convId),
      { initialProps: { convId: 'conv-A' } }
    )
    await act(async () => { void result.current.addFiles([pngFile()]) })
    expect(result.current.staged).toHaveLength(1)
    expect(result.current.staged[0].uploading).toBe(true)

    rerender({ convId: 'conv-B' })

    expect(result.current.staged).toHaveLength(0)
    expect(revokeSpy).toHaveBeenCalledWith('blob:pending-1')
    revokeSpy.mockRestore()
    createSpy.mockRestore()
  })

  it('挂载时不误清空：首次 render 无 conversationId 变化，同 id rerender 保留既有 staged（ref 比较防误触）', async () => {
    uploadMock.mockResolvedValue({ attachments: [dto('srv-1', 'a.png')] })
    const { result, rerender } = renderHook(
      ({ convId }: { convId: string }) => useAttachmentStaging(convId),
      { initialProps: { convId: 'conv-1' } }
    )
    await act(async () => { await result.current.addFiles([pngFile()]) })

    rerender({ convId: 'conv-1' }) // 同 id rerender

    expect(result.current.staged).toHaveLength(1)
  })

  it('上传失败：uploadError 结构化携带 HTTP status（ApiError 语义保留，发现 3）', async () => {
    const { ApiError } = await import('../../../api/client')
    uploadMock.mockRejectedValue(new ApiError('文件过大', 413))
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))

    await act(async () => { await result.current.addFiles([pngFile()]) })

    expect(result.current.staged).toHaveLength(0)
    expect(result.current.uploadError?.message).toBe('文件过大')
    expect(result.current.uploadError?.status).toBe(413)
  })

  it('上传失败：网络/未知错误 status 为 null（非 ApiError 不伪造 HTTP 语义）', async () => {
    uploadMock.mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useAttachmentStaging('conv-1'))

    await act(async () => { await result.current.addFiles([pngFile()]) })

    expect(result.current.uploadError?.message).toBe('network down')
    expect(result.current.uploadError?.status).toBeNull()
  })
})
