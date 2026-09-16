// @vitest-environment jsdom
/**
 * F20260916sgcl 回归：发送成功后附件中转区必须清空。
 * 旧链路：MessageInput 直接透传 staged 给 onSend，没有任何环节调 clearAll/takeForSend，
 * 导致悬浮缩略图发送后不消失、下一条消息重复携带同一附件。
 * 本测试锁定：点发送 → onSend 被调用（携带附件）→ 中转区 DOM 消失。
 *
 * 测试设施：MessageList 太重（滚动 observer/语法高亮），stub 掉——本测试只关心
 * 输入区与中转区的联动，消息列表渲染与本修复无关。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { createRef } from 'react'

vi.mock('./MessageList', () => ({
  MessageList: () => <div data-testid="message-list-stub" />,
}))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, uploadAttachments: vi.fn() }
})
vi.mock('../../components/Toast', () => ({ showToast: vi.fn() }))

import { ChatView } from './ChatView'
import * as api from '../../api/client'
import type { LocalConversation, LocalOtter, LocalMessage } from '../../lib/mappers'

const uploadMock = vi.mocked(api.uploadAttachments)

function pngFile(name = 'shot.png'): File {
  return new File([new ArrayBuffer(10)], name, { type: 'image/png' })
}

function renderChatView(onSend = vi.fn()) {
  const conversation = { id: 'conv-1', title: 't', status: 'active' } as unknown as LocalConversation
  const isAtBottomRef = createRef<boolean>() as React.MutableRefObject<boolean>
  isAtBottomRef.current = true
  const utils = render(
    <ChatView
      conversation={conversation}
      messages={[] as LocalMessage[]}
      state="normal"
      onSend={onSend}
      onStopStream={vi.fn()}
      onRetryMessage={vi.fn()}
      onRetry={vi.fn()}
      onGoToSettings={vi.fn()}
      onArchive={vi.fn()}
      otters={[] as LocalOtter[]}
      conversationId="conv-1"
      isAtBottomRef={isAtBottomRef}
    />
  )
  const textarea = utils.container.querySelector('textarea')!
  return { ...utils, textarea, onSend }
}

function firePaste(el: Element, files: File[]) {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    value: {
      files: files as unknown as FileList,
      types: ['Files'],
      getData: () => '',
    },
  })
  el.dispatchEvent(ev)
}

beforeEach(() => {
  uploadMock.mockReset()
})

describe('ChatView 附件中转区发送清空（F20260916sgcl）', () => {
  it('粘贴截图 → 中转区出现缩略图 → 发送后中转区清空且 onSend 携带附件', async () => {
    uploadMock.mockResolvedValue({
      attachments: [{ id: 'srv-1', kind: 'image', originalName: 'shot.png', mimeType: 'image/png', sizeBytes: 10, width: 100, height: 100 }],
    })
    const { textarea, container, onSend } = renderChatView()

    // 粘贴截图 → 进入中转区
    await act(async () => { firePaste(textarea, [pngFile()]) })
    expect(container.querySelector('img[alt="shot.png"]')).toBeTruthy()

    // 点发送（steer 主按钮）
    const sendBtn = container.querySelector('button[title^="发送（steer"]')!
    await act(async () => { (sendBtn as HTMLButtonElement).click() })

    // onSend 收到附件
    expect(onSend).toHaveBeenCalledTimes(1)
    const [, , atts] = onSend.mock.calls[0]
    expect(atts).toHaveLength(1)
    expect(atts[0].id).toBe('srv-1')

    // 中转区已清空——缩略图消失
    expect(container.querySelector('img[alt="shot.png"]')).toBeNull()
  })

  it('onSend 异步 reject（发送失败）→ 中转区保留供重试（S1 回归）', async () => {
    uploadMock.mockResolvedValue({
      attachments: [{ id: 'srv-1', kind: 'image', originalName: 'shot.png', mimeType: 'image/png', sizeBytes: 10, width: 100, height: 100 }],
    })
    // 真实失败路径：index.tsx handleSend catch 后 rethrow → Promise reject
    const failingSend = vi.fn().mockRejectedValue(new Error('network down'))
    const { textarea, container } = renderChatView(failingSend)

    await act(async () => { firePaste(textarea, [pngFile()]) })
    expect(container.querySelector('img[alt="shot.png"]')).toBeTruthy()

    const sendBtn = container.querySelector('button[title^="发送（steer"]')!
    await act(async () => { (sendBtn as HTMLButtonElement).click() })
    // 等 await 链落定
    await act(async () => { await Promise.resolve() })

    // 失败路径：缩略图仍在（blob 未被 revoke，用户可重试）
    expect(container.querySelector('img[alt="shot.png"]')).toBeTruthy()
  })
})
