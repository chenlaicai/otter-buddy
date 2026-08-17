// @vitest-environment jsdom
/**
 * F20260814qswp：MessageList 流式过程面板事件渲染测试（AT-2 证据链最后一环）。
 *
 * 重试流 SSE 处理器曾产出 eventType:'text'/payload:{text} 的漂移形状，
 * EventItem 只识别 'assistant_text' 导致重试消息的流式文本事件静默丢失（return null）。
 * 本测试锁定：修复后形状（'assistant_text' + payload.content blocks）渲染文本预览；
 * 旧形状（'text'）不渲染任何事件行——防止再次漂移时无声回归。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageList } from './MessageList'
import type { LocalMessage, LocalMessageEvent } from '../../lib/mappers'

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

function msg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', st: 'otter', si: 'otter-1', sn: '大獭', content: '最终正文',
    status: 'completed', ts: '2026-08-14T00:00:00Z', dur: null, ...overrides,
  }
}

function render(list: LocalMessage[]) {
  act(() => {
    root.render(
      <MessageList
        messages={list}
        state="normal"
        onStopStream={() => {}}
        onRetryMessage={() => {}}
        onRetry={() => {}}
        onGoToSettings={() => {}}
        otters={[]}
        conversationId="conv-1"
        isAtBottomRef={{ current: true }}
      />,
    )
  })
}

/** 展开流式过程面板（终态默认折叠）。注意：需用原生 HTMLElement.click()，
 *  dispatchEvent(new MouseEvent) 不触发 React 合成事件 */
function expandProcessPanel() {
  const header = Array.from(container.querySelectorAll('div.streaming-section > div')).find(d => d.textContent?.includes('已完成'))
  expect(header, '未找到流式过程面板头').toBeTruthy()
  act(() => { (header as HTMLElement).click() })
}

describe('MessageList 流式过程面板事件渲染', () => {
  it('assistant_text 事件（修复后重试流形状）渲染徽标与文本预览', () => {
    const events: LocalMessageEvent[] = [{
      ts: '2026-08-14T00:00:01Z',
      eventType: 'assistant_text',
      payload: { content: [{ type: 'text', text: '这是重试流的第一段实时文本' }] },
    }]
    render([msg({ events })])
    expandProcessPanel()
    expect(container.textContent).toContain('assistant_text')
    expect(container.textContent).toContain('这是重试流的第一段实时文本')
  })

  it('旧漂移形状（eventType:text）不渲染事件行——回归对照', () => {
    const events: LocalMessageEvent[] = [{
      ts: '2026-08-14T00:00:01Z',
      eventType: 'text',
      payload: { text: '这段文本曾静默丢失' },
    }]
    render([msg({ events })])
    expandProcessPanel()
    expect(container.textContent).not.toContain('assistant_text')
    expect(container.textContent).not.toContain('这段文本曾静默丢失')
  })

  it('tool_result 事件正常渲染（同面板多事件类型共存）', () => {
    const events: LocalMessageEvent[] = [
      { ts: '2026-08-14T00:00:01Z', eventType: 'assistant_text', payload: { content: [{ type: 'text', text: '思考中' }] } },
      { ts: '2026-08-14T00:00:02Z', eventType: 'tool_result', payload: { name: 'search_memory', result: { content: [{ text: '结果预览' }] } } },
    ]
    render([msg({ events })])
    expandProcessPanel()
    expect(container.textContent).toContain('assistant_text')
    expect(container.textContent).toContain('tool_result')
    expect(container.textContent).toContain('search_memory')
  })

  it('无 events 的消息不渲染流式过程面板', () => {
    render([msg()])
    const header = Array.from(container.querySelectorAll('div')).find(d => d.textContent?.includes('已完成'))
    expect(header).toBeUndefined()
  })
})
