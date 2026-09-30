// @vitest-environment jsdom
/**
 * useConversationListPolling 回归测试（F20260930zzr5 / issue #1249）
 *
 * 事故链路：对话实际 awaiting_user，左侧栏仍显示「处理中」。
 * 根因层（孤儿 running invoke）已由 F20260930roiv 延迟 reconcile 修复；
 * 本文件锁死显示链路的三个行为：
 * 1. 5s 轮询 tick：服务端状态翻转后，列表数据跟随翻转
 * 2. 切回标签页：立即刷新一次，不等首个 5s tick（旧 badge 最长滞留 5s）
 * 3. fetching 防重入：慢请求挂起期间 tick/visible 不叠加拉取
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useConversationListPolling } from './use-conversation-list-polling'
import * as api from '../api/client'
import type { LocalConversation } from '../lib/mappers'

vi.mock('../api/client', () => ({
  listConversations: vi.fn(),
}))

const listConversations = vi.mocked(api.listConversations)

function conv(id: string, activityStatus: LocalConversation['activityStatus']): LocalConversation {
  return {
    id, title: '对话-' + id, status: 'active', otterIds: [], pinned: false,
    activityStatus, unreadCount: 0, lastMessagePreview: null,
  } as LocalConversation
}

function dtoOf(c: LocalConversation) {
  return { ...c }
}

let setConversations: ReturnType<typeof vi.fn>

describe('useConversationListPolling - 左栏状态回归（#1249）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConversations = vi.fn()
    listConversations.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('服务端状态翻转 processing → awaiting_user 后，轮询 tick 推动列表翻转', async () => {
    listConversations
      .mockResolvedValueOnce({ items: [dtoOf(conv('c1', 'processing'))], total: 1 } as never)
      .mockResolvedValueOnce({ items: [dtoOf(conv('c1', 'awaiting_user'))], total: 1 } as never)

    renderHook(() => useConversationListPolling(true, setConversations as never))
    // 初始挂载不立即拉——首个数据在 5s tick 到来
    expect(listConversations).toHaveBeenCalledTimes(0)

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(listConversations).toHaveBeenCalledTimes(1)
    expect(setConversations).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(listConversations).toHaveBeenCalledTimes(2)

    // 第二次拉取的结果应携带 awaiting_user（merge 后未被本地 processing 粘住）
    const secondCallArg = setConversations.mock.calls[1][0] as (prev: LocalConversation[]) => LocalConversation[]
    const merged = secondCallArg([conv('c1', 'processing')])
    expect(merged[0].activityStatus).toBe('awaiting_user')
  })

  it('切回标签页立即刷新，不等首个 5s tick（#1249：旧 badge 滞留窗口压缩到 0）', async () => {
    listConversations.mockResolvedValue({ items: [dtoOf(conv('c1', 'awaiting_user'))], total: 1 } as never)

    renderHook(() => useConversationListPolling(true, setConversations as never))
    expect(listConversations).toHaveBeenCalledTimes(0)

    // 隐藏 → 切回：立即触发一次拉取，不等 5s
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(listConversations).toHaveBeenCalledTimes(1)
  })

  it('fetching 防重入：慢请求挂起期间 tick/visible 不叠加拉取', async () => {
    // 慢响应：永不 resolve——visible 立即刷新发起后，5s tick 到来应被防重入跳过
    listConversations.mockImplementation(() => new Promise(() => {}))

    renderHook(() => useConversationListPolling(true, setConversations as never))

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(listConversations).toHaveBeenCalledTimes(1)
  })
})
