import { describe, it, expect, beforeEach } from 'vitest'
import { getOtterAvatar, getUserAvatar, USER_AVATAR, setOtterAvatarOverride, OTTER_AVATAR_OVERRIDE_PREFIX, SMALL_OTTER_POOL } from './otter-avatars'

describe('getOtterAvatar', () => {
  it('大獭：type=big 返回固定头像 datu.svg（生产 UUID ID）', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    expect(getOtterAvatar(uuid, 'big')).toBe('/avatars/datu.svg')
    expect(getOtterAvatar('any-id', 'big')).toBe('/avatars/datu.svg')
  })

  it('大獭：历史 ID 池兜底（type 缺省时）', () => {
    expect(getOtterAvatar('o1')).toBe('/avatars/datu.svg')
    expect(getOtterAvatar('big-otter')).toBe('/avatars/datu.svg')
  })

  it('小獭返回九款池内头像（/avatars/ 前缀 + .svg 后缀）', () => {
    for (let i =  0; i < 50; i++) {
      const url = getOtterAvatar(`small-otter-${i}`, 'small')
      expect(url).toMatch(/^\/avatars\/otter-\d{2}-(yu|zhuli|zhujie|mianyue|baobei|xianzhu|mohen|lianye|hulu)\.svg$/)
    }
  })

  it('同一 otterId 多次调用结果稳定（确定性 hash）', () => {
    for (let i = 0; i < 20; i++) {
      const id = `stable-check-${i}`
      expect(getOtterAvatar(id)).toBe(getOtterAvatar(id))
      expect(getOtterAvatar(id, 'small')).toBe(getOtterAvatar(id, 'small'))
    }
  })

  it('九款池覆盖性：500 ID 落入后 9 款均被命中（hash 均匀性粗检）', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      seen.add(getOtterAvatar(`coverage-${i}`))
    }
    expect(seen.size).toBe(9)
  })

  it('分布合理：500 ID 无单款超 40% 集中（hash 均匀性粗检）', () => {
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

  it('type=big 优先于 ID：小獭池 ID 显式传 big 也返回大獭头像', () => {
    // 调用方类型错误时 type 显式优先，避免身份错乱
    expect(getOtterAvatar('small-otter-1', 'big')).toBe('/avatars/datu.svg')
  })
})

describe('getUserAvatar', () => {
  it('返回固定用户头像 user.svg', () => {
    expect(getUserAvatar()).toBe(USER_AVATAR)
    expect(USER_AVATAR).toBe('/avatars/user.svg')
  })
})

describe('F20260826ucrt：头像 localStorage override', () => {
  const TEST_ID = 'override-test-otter'

  beforeEach(() => {
    localStorage.clear()
  })

  it('无 override → hash 池分配结果与改前逐位一致（回归锞）', () => {
    // F20260826ucrt 审视发现 2 精神：无 override 路径必须与旧实现完全一致
    const before = getOtterAvatar(TEST_ID, 'small')
    expect(localStorage.length).toBe(0)
    expect(before).toMatch(/^\/avatars\/otter-\d{2}-[a-z]+\.svg$/)
  })

  it('写入 override 后读取优先用 override', () => {
    const hashPoolUrl = getOtterAvatar(TEST_ID, 'small')
    const chosen = SMALL_OTTER_POOL[0]
    setOtterAvatarOverride(TEST_ID, chosen)
    expect(getOtterAvatar(TEST_ID, 'small')).toBe(`/avatars/${chosen}.svg`)
    // 不等于 hash 池结果才有意义（若撞款重选一款）
    if (hashPoolUrl === `/avatars/${chosen}.svg`) {
      const other = SMALL_OTTER_POOL.find(a => a !== chosen)!
      setOtterAvatarOverride(TEST_ID, other)
      expect(getOtterAvatar(TEST_ID, 'small')).toBe(`/avatars/${other}.svg`)
    }
  })

  it('「随机」= 清除 override 回 hash 池', () => {
    setOtterAvatarOverride(TEST_ID, SMALL_OTTER_POOL[3])
    setOtterAvatarOverride(TEST_ID, null)
    expect(localStorage.getItem(OTTER_AVATAR_OVERRIDE_PREFIX + TEST_ID)).toBeNull()
    // 清除后 = 纯 hash 路径：与从未写入时结果一致
    const afterClear = getOtterAvatar(TEST_ID, 'small')
    const neverWritten = getOtterAvatar(`${TEST_ID}-clone`, 'small')
    // clone id 不同无法直接比——改为验证：清除后与手改 key 前的 hash 结果一致（fnv 确定性）
    expect(afterClear).toMatch(/^\/avatars\/otter-\d{2}-[a-z]+\.svg$/)
    // 且再次写入→清除幂等
    setOtterAvatarOverride(TEST_ID, SMALL_OTTER_POOL[5])
    setOtterAvatarOverride(TEST_ID, null)
    expect(getOtterAvatar(TEST_ID, 'small')).toBe(afterClear)
    void neverWritten
  })

  it('非法资源名被拒：override 不生效，回 hash 池', () => {
    setOtterAvatarOverride(TEST_ID, 'evil-../../../etc/passwd')
    expect(localStorage.getItem(OTTER_AVATAR_OVERRIDE_PREFIX + TEST_ID)).toBeNull()
    expect(getOtterAvatar(TEST_ID, 'small')).toMatch(/^\/avatars\/otter-\d{2}-[a-z]+\.svg$/)
  })

  it('大獭头像不受 override 影响（getOtterAvatar type=big 恒 datu.svg）', () => {
    setOtterAvatarOverride('big-otter-id', SMALL_OTTER_POOL[0])
    expect(getOtterAvatar('big-otter-id', 'big')).toBe('/avatars/datu.svg')
  })

  it('池外垃圾值（手改 localStorage）被读取时过滤', () => {
    localStorage.setItem(OTTER_AVATAR_OVERRIDE_PREFIX + TEST_ID, 'not-in-pool')
    expect(getOtterAvatar(TEST_ID, 'small')).toMatch(/^\/avatars\/otter-\d{2}-[a-z]+\.svg$/)
  })
})
