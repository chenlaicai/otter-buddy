import { describe, it, expect } from 'vitest'
import { getOtterAvatar, getUserAvatar, USER_AVATAR } from './otter-avatars'

describe('getOtterAvatar', () => {
  it('大獭 ID 池返回固定头像 datu.svg', () => {
    expect(getOtterAvatar('o1')).toBe('/avatars/datu.svg')
    expect(getOtterAvatar('big-otter')).toBe('/avatars/datu.svg')
  })

  it('小獭返回九款池内头像（/avatars/ 前缀 + .svg 后缀）', () => {
    for (let i = 0; i < 50; i++) {
      const url = getOtterAvatar(`small-otter-${i}`)
      expect(url).toMatch(/^\/avatars\/otter-\d{2}-(yu|zhuli|zhujie|mianyue|baobei|xianzhu|mohen|lianye|hulu)\.svg$/)
    }
  })

  it('同一 otterId 多次调用结果稳定（确定性 hash）', () => {
    for (let i = 0; i < 20; i++) {
      const id = `stable-check-${i}`
      expect(getOtterAvatar(id)).toBe(getOtterAvatar(id))
    }
  })

  it('九款池覆盖性：大量 ID 落入后 9 款均被命中（hash 均匀性粗检）', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      seen.add(getOtterAvatar(`coverage-${i}`))
    }
    expect(seen.size).toBe(9)
  })

  it('不同 ID 分布合理：500 个 ID 无单款超 40% 集中（hash 均匀性粗检）', () => {
    const counts = new Map<string, number>()
    const N = 500
    for (let i = 0; i < N; i++) {
      const url = getOtterAvatar(`dist-${i}`)
      counts.set(url, (counts.get(url) || 0) + 1)
    }
    for (const count of counts.values()) {
      expect(count / N).toBeLessThan(0.4)
    }
  })

  it('相邻 ID 头像分布打散（避免连续小獭全撞同一款）', () => {
    const a = getOtterAvatar('neighbor-a')
    const b = getOtterAvatar('neighbor-b')
    const c = getOtterAvatar('neighbor-c')
    expect(new Set([a, b, c]).size).toBeGreaterThan(1)
  })
})

describe('getUserAvatar', () => {
  it('返回固定用户头像 user.svg', () => {
    expect(getUserAvatar()).toBe(USER_AVATAR)
    expect(USER_AVATAR).toBe('/avatars/user.svg')
  })
})
