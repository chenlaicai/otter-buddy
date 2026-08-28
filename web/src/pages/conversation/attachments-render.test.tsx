// @vitest-environment jsdom
/**
 * 多模态 Phase 1 前端附件：MessageList 消息气泡附件渲染测试。
 * 锁定行为：带 atts 的消息渲染图片缩略图（src 指向服务端端点）与
 * document 文件卡（含文件名与大小）；多图走网格布局。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from './MessageList'
import type { LocalMessage, LocalAttachment } from '../../lib/mappers'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function att(id: string, kind: 'image' | 'document', name: string, sizeBytes = 2048): LocalAttachment {
  return { id, kind, originalName: name, mimeType: kind === 'image' ? 'image/png' : 'text/plain', sizeBytes }
}

function render(messages: LocalMessage[]) {
  act(() => {
    root.render(
      <MessageList
        messages={messages}
        state="normal"
        onStopStream={() => {}}
        onRetryMessage={() => {}}
        onRetry={() => {}}
        onGoToSettings={() => {}}
        otters={[]}
        conversationId="conv-1"
        isAtBottomRef={{ current: true }}
        onReachBottom={() => {}}
      />,
    )
  })
}

describe('MessageList 附件渲染（多模态 Phase 1）', () => {
  it('带图片附件的 user 消息渲染缩略图，src 指向服务端附件端点', () => {
    const msg: LocalMessage = {
      id: 'm1', st: 'user', si: 'user', content: '看这张图',
      status: 'completed', ts: '2026-08-28T00:00:00Z', dur: null,
      atts: [att('att-img-1', 'image', 'photo.png', 1024 * 1024)],
    }
    render([msg])
    const img = container.querySelector('img[src="/api/attachments/att-img-1"]')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('alt')).toBe('photo.png')
  })

  it('带 document 附件的消息渲染文件卡（文件名 + 大小）', () => {
    const msg: LocalMessage = {
      id: 'm2', st: 'user', si: 'user', content: '见附件',
      status: 'completed', ts: '2026-08-28T00:00:00Z', dur: null,
      atts: [att('att-doc-1', 'document', 'notes.txt', 4096)],
    }
    render([msg])
    const link = container.querySelector<HTMLAnchorElement>('a[href="/api/attachments/att-doc-1"]')
    expect(link).not.toBeNull()
    expect(link!.textContent).toContain('notes.txt')
    expect(link!.textContent).toContain('4.0KB')
  })

  it('多图附件渲染为多个缩略图（独立端点引用）', () => {
    const msg: LocalMessage = {
      id: 'm3', st: 'user', si: 'user', content: '两张对比',
      status: 'completed', ts: '2026-08-28T00:00:00Z', dur: null,
      atts: [att('att-1', 'image', 'a.png'), att('att-2', 'image', 'b.png')],
    }
    render([msg])
    expect(container.querySelectorAll('img[src^="/api/attachments/"]').length).toBe(2)
  })

  it('混合附件：图片与文档各自按类型渲染', () => {
    const msg: LocalMessage = {
      id: 'm4', st: 'user', si: 'user', content: '',
      status: 'completed', ts: '2026-08-28T00:00:00Z', dur: null,
      atts: [att('att-i', 'image', 'pic.png'), att('att-d', 'document', 'data.csv', 512)],
    }
    render([msg])
    expect(container.querySelector('img[src="/api/attachments/att-i"]')).not.toBeNull()
    expect(container.querySelector('a[href="/api/attachments/att-d"]')!.textContent).toContain('data.csv')
  })

  it('无附件消息不受影响（不渲染附件块）', () => {
    const msg: LocalMessage = {
      id: 'm5', st: 'user', si: 'user', content: '纯文本',
      status: 'completed', ts: '2026-08-28T00:00:00Z', dur: null,
    }
    render([msg])
    expect(container.querySelectorAll('img[src^="/api/attachments/"]').length).toBe(0)
    expect(container.querySelectorAll('a[href^="/api/attachments/"]').length).toBe(0)
  })
})
