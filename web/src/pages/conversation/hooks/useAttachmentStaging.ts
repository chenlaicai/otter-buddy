/**
 * 多模态 Phase 1：附件上传中转状态（选择 → 上传 → 随消息发送）。
 *
 * 独立 hook 而非塞进 useDraftCache：草稿是纯文本可 localStorage 持久化，
 * 附件含 File 对象（不可序列化）且上传后就是服务端 id 引用——生命周期不同，不混存。
 * 会话切换即清空（未发送的附件选择不跨会话保留，与草稿行为差异是刻意决策：
 * 附件上传有服务端落盘副作用，遗留状态容易误发——PR #546 审视发现 1 后落地：
 * 清空逻辑收进 hook 内部 effect，调用方（ChatView 不重挂载）免费获得，
 * 不依赖调用方记得调 clearAll）。
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import * as api from '../../../api/client'
import { ApiError } from '../../../api/client'
import type { AttachmentDTO } from '@contract/api'
import type { LocalAttachment } from '../../../lib/mappers'
import { pickValidFiles, MAX_FILES_PER_UPLOAD, MAX_IMAGES_PER_SEND, type RejectedFile } from '../../../lib/attachments'

/** 中转条目：上传成功后 DTO 替代本地 File（服务端 id 是发送时的唯一引用） */
export interface StagedAttachment extends LocalAttachment {
  /** 上传中暂存本地预览 URL；上传完成置 null（渲染切到服务端 GET 端点） */
  localPreviewUrl?: string
  uploading: boolean
}

/** 上传错误结构化透出（PR #546 审视发现 3）：status 保留 HTTP 语义（400 MIME/413 超限/415 类型），
 *  供 UI 层按需分流展示；网络/未知错误 status 为 null */
export interface UploadErrorInfo {
  message: string
  status: number | null
}

export function useAttachmentStaging(conversationId: string | null) {
  const [staged, setStaged] = useState<StagedAttachment[]>([])
  const [uploadError, setUploadError] = useState<UploadErrorInfo | null>(null)

  /** 选择并立即上传；部分失败不阻塞其余（后端逐文件走管线，单个 400 不影响整批） */
  const addFiles = useCallback(async (files: File[]) => {
    if (!conversationId || files.length === 0) return
    setUploadError(null)
    const [valid, rejected] = pickValidFiles(files)
    if (rejected.length > 0) {
      setUploadError({ message: rejected.map(r => `${r.name}：${r.reason}`).join('；'), status: null })
    }
    if (valid.length === 0) return

    const batch = [...valid].slice(0, MAX_FILES_PER_UPLOAD)
    // 本地占位（uploading 态显示预览/文件名）
    const placeholders: StagedAttachment[] = batch.map(f => ({
      id: `tmp-${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`,
      kind: (f.type.startsWith('image/') ? 'image' : 'document') as 'image' | 'document',
      originalName: f.name,
      mimeType: f.type || 'application/octet-stream',
      sizeBytes: f.size,
      localPreviewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      uploading: true,
    }))
    setStaged(prev => [...prev, ...placeholders])

    try {
      const resp = await api.uploadAttachments(conversationId, batch)
      // 用服务端返回替换占位（按 originalName 顺序对齐：后端保序返回）
      setStaged(prev => {
        const replaced = [...prev]
        let dtoIndex = 0
        for (let i = 0; i < replaced.length; i++) {
          if (replaced[i].uploading && dtoIndex < resp.attachments.length) {
            const att = resp.attachments[dtoIndex++]
            const old = replaced[i]
            if (old.localPreviewUrl) URL.revokeObjectURL(old.localPreviewUrl)
            replaced[i] = { ...att, uploading: false }
          }
        }
        return replaced
      })
    } catch (err) {
      // 上传失败：移除全部占位并提示（不留在中转区——用户重选即可，无服务端残留）
      setStaged(prev => {
        for (const p of placeholders) if (p.localPreviewUrl) URL.revokeObjectURL(p.localPreviewUrl)
        return prev.filter(s => !placeholders.some(p => p.id === s.id))
      })
      setUploadError(err instanceof ApiError
        ? { message: err.message, status: err.status }
        : { message: err instanceof Error ? err.message : '上传失败', status: null })
    }
  }, [conversationId])

  const remove = useCallback((id: string) => {
    setStaged(prev => {
      const target = prev.find(s => s.id === id)
      if (target?.localPreviewUrl) URL.revokeObjectURL(target.localPreviewUrl)
      return prev.filter(s => s.id !== id)
    })
  }, [])

  /** 发送时提取：清空中转区并返回 DTO 数组（含每轮图片上限兜底校验） */
  const takeForSend = useCallback((): { attachments: LocalAttachment[]; error?: string } => {
    if (staged.some(s => s.uploading)) {
      return { attachments: [], error: '附件还在上传中，请稍候' }
    }
    const imageCount = staged.filter(s => s.kind === 'image').length
    if (imageCount > MAX_IMAGES_PER_SEND) {
      return { attachments: [], error: `图片附件超过每轮上限（${MAX_IMAGES_PER_SEND} 张）` }
    }
    for (const s of staged) if (s.localPreviewUrl) URL.revokeObjectURL(s.localPreviewUrl)
    const attachments = staged.map(({ localPreviewUrl: _u, uploading: _up, ...att }) => att)
    setStaged([])
    return { attachments }
  }, [staged])

  /** 全量清空中转区（释放所有预览 blob + 错误置空）：由下方会话切换 effect 自动触发，
   *  也保留手动调用能力（如未来需要“清空草稿”类操作） */
  const clearAll = useCallback(() => {
    setStaged(prev => {
      for (const p of prev) if (p.localPreviewUrl) URL.revokeObjectURL(p.localPreviewUrl)
      return []
    })
    setUploadError(null)
  }, [])

  /** 会话切换即清空（发现 1 修复）：ref 比较只在 id 真变化时触发（挂载不清空，
   *  避免无谓 rerender）；ChatView 不重挂载，靠本 effect 隔离会话 A/B 的中转状态。
   *  进行中的上传完成回调（DTO 替换遍历 uploading 条目）在清空后的空列表上空转，不会复活条目。 */
  const prevConversationIdRef = useRef(conversationId)
  useEffect(() => {
    if (prevConversationIdRef.current !== conversationId) {
      prevConversationIdRef.current = conversationId
      clearAll()
    }
  }, [conversationId, clearAll])

  return { staged, uploadError, addFiles, remove, takeForSend, clearAll, setUploadError }
}

export type { RejectedFile, AttachmentDTO }
