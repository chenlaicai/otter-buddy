// @vitest-environment jsdom
/**
 * F20261008csf1 P1：链类 unfurl 预览卡测试。
 * 锁定行为：①裸链段落（消息正文只有一个 URL）渲染预览卡；②抓取失败降级普通链接；
 * ③句中链接（有上下文文字）不抢排版，维持行内样式；④Markdown 链接 [label](url) 不出卡。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from './MessageList'
import { isBareUrlText, fetchUnfurl } from './UnfurlCard'
import type { LocalMessage } from '../../lib/mappers'

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
  vi.unstubAllGlobals()
})

function msg(id: string, content: string): LocalMessage {
  return {
    id, st: 'otter', si: 'ot-1', content,
    status: 'completed', ts: '2026-10-08T09:00:00Z', dur: null,
  }
}

function renderOne(content: string) {
  act(() => {
    root.render(
      <MessageList
        messages={[msg('m1', content)]}
        state="normal"
        onStopStream={() => {}}
        onRetryMessage={() => {}}
        onRetry={() => {}}
        onGoToSettings={() => {}}
        otters={[]}
        conversationId="conv-1"
        pinRef={{ current: true }}
      />,
    )
  })
}

describe('isBareUrlText（裸链判定）', () => {
  it('纯 URL 文本判定为裸链', () => {
    expect(isBareUrlText('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })
  it('带前后空白的纯 URL 也算', () => {
    expect(isBareUrlText('  https://example.com/x  ')).toBe('https://example.com/x')
  })
  it('句中链接（有上下文）不是裸链', () => {
    expect(isBareUrlText('看这个 https://example.com/x 很不错')).toBeNull()
  })
  it('Markdown 链接形态不是裸链（有作者锚文本）', () => {
    expect(isBareUrlText('[文档](https://example.com/x)')).toBeNull()
  })
  it('多行文本不是裸链', () => {
    expect(isBareUrlText('https://a.com\nhttps://b.com')).toBeNull()
  })
})

describe('UnfurlCard 降级行为', () => {
  it('fetch 失败时渲染普通链接（与未接本特性前一致）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    renderOne('https://example.com/down')
    // 等 effect 落定
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    const a = container.querySelector('a[href="https://example.com/down"]')
    expect(a).not.toBeNull()
    expect(a!.textContent).toContain('example.com')
    // 不应有卡片结构
    expect(container.querySelector('[class*="rounded-xl"]')).toBeNull()
  })

  it('抓取成功时渲染预览卡（标题+描述+站点）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      url: 'https://example.com/x',
      title: '示例标题',
      description: '示例描述',
      image: null,
      siteName: '示例站',
      host: 'example.com',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    renderOne('https://example.com/x')
    // 等 effect 落定：fetch mock → resp.json() → setState 是多跳微任务链
    //（Response.json() 在 Node 18+ 返回新 Promise），两轮 flush 冲不干净
    for (let i = 0; i < 6; i++) {
      await act(async () => { await Promise.resolve() })
    }
    expect(container.textContent).toContain('示例标题')
    expect(container.textContent).toContain('示例站 · example.com')
  })

  it('句中链接维持行内样式（不出预览卡）', async () => {
    renderOne('看这个 https://example.com/x 很不错')
    await act(async () => { await Promise.resolve() })
    const a = container.querySelector('a[href="https://example.com/x"]')
    expect(a).not.toBeNull()
    expect(container.textContent).not.toContain('加载预览')
  })
})

describe('fetchUnfurl', () => {
  it('网络异常返回 null（调用方据此降级）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net down') }))
    expect(await fetchUnfurl('https://example.com/x')).toBeNull()
  })
  it('非 2xx 返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    expect(await fetchUnfurl('https://example.com/x')).toBeNull()
  })
})
