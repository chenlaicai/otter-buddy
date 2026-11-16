// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { listConversations } from './client'

describe('client 401 广播（#1868 会话门）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('服务端 401 → 广播 otter:unauthorized 并抛 ApiError', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    await expect(listConversations()).rejects.toMatchObject({ status: 401 })
    const dispatched = dispatch.mock.calls.map(c => c[0])
    expect(dispatched.some(e => (e as CustomEvent).type === 'otter:unauthorized')).toBe(true)
  })
})