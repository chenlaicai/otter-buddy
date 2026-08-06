import { describe, it, expect } from 'vitest'
import { mergeConversations } from './merge-conversations'
import type { LocalConversation } from './mappers'

function conv(overrides: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id: 'conv-1',
    title: '对话',
    status: 'active',
    pinned: false,
    otterIds: [],
    ...overrides,
  }
}

describe('mergeConversations（F20260805actv 轮询合并）', () => {
  it('服务端未读增长时用服务端权威值（本地旧值不得冻结徽章）', () => {
    const prev = [conv({ unreadCount: 1 })]
    const next = [conv({ unreadCount: 3 })]
    expect(mergeConversations(prev, next)[0].unreadCount).toBe(3)
  })

  it('markRead 后服务端清零，轮询结果同步清零', () => {
    const prev = [conv({ unreadCount: 5 })]
    const next = [conv({ unreadCount: 0 })]
    expect(mergeConversations(prev, next)[0].unreadCount).toBe(0)
  })

  it('服务端字段缺失时回退本地值', () => {
    const prev = [conv({ unreadCount: 2 })]
    const next = [conv({ unreadCount: undefined })]
    expect(mergeConversations(prev, next)[0].unreadCount).toBe(2)
  })

  it('unreadCount: 0 是有效值，不触发 fallback（?? 区分 0 与 undefined）', () => {
    const prev = [conv({ unreadCount: 5 })]
    const next = [conv({ unreadCount: 0 })]
    expect(mergeConversations(prev, next)[0].unreadCount).toBe(0)
  })

  it('实时字段以服务端为准（activityStatus / lastMessagePreview）', () => {
    const prev = [conv({ activityStatus: 'awaiting_user', lastMessagePreview: '旧' })]
    const next = [conv({ activityStatus: 'processing', lastMessagePreview: '新' })]
    const [merged] = mergeConversations(prev, next)
    expect(merged.activityStatus).toBe('processing')
    expect(merged.lastMessagePreview).toBe('新')
  })

  it('服务端新出现的对话直接加入', () => {
    const prev = [conv({ id: 'conv-1' })]
    const next = [conv({ id: 'conv-1' }), conv({ id: 'conv-2', title: '新对话' })]
    const merged = mergeConversations(prev, next)
    expect(merged).toHaveLength(2)
    expect(merged[1].id).toBe('conv-2')
  })

  it('服务端消失的对话（如归档）从列表移除', () => {
    const prev = [conv({ id: 'conv-1' }), conv({ id: 'conv-2' })]
    const next = [conv({ id: 'conv-1' })]
    const merged = mergeConversations(prev, next)
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('conv-1')
  })

  it('保持服务端排序顺序', () => {
    const prev = [conv({ id: 'a' }), conv({ id: 'b' })]
    const next = [conv({ id: 'b', pinned: true }), conv({ id: 'a' })]
    expect(mergeConversations(prev, next).map(c => c.id)).toEqual(['b', 'a'])
  })
})
