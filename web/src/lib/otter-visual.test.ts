/**
 * F20260921otcl：resolveOtterVisual 单一入口测试。
 *
 * 覆盖：
 * 1. 方案「失败用例先行」两条的常驻迁移（修复前红证据见 PR Verification）：
 *    - 大獭（UUID + type='big'）颜色 === 品牌棕
 *    - 两个大獭 UUID 先后到达互不挤占、各自稳定（旧动态池挤占病灶）
 * 2. 三态：identity 完整走库值 / color NULL 走 fnv1a 回退 / identity 缺失走回退
 * 3. 大獭 color 不参与（type 判定优先）
 */
import { describe, it, expect } from 'vitest'
import { resolveOtterVisual } from './otter-visual'
import { OTTER_PALETTE_KEYS, OTTER_PALETTE_HEX } from '@contract/api/otter-palette'

describe('resolveOtterVisual — 失败用例常驻迁移（F20260921otcl）', () => {
  it('大獭（UUID + type=big）颜色恒品牌棕——不传 type（MessageList 旧形态）与大獭历史消息回退路径均稳定', () => {
    const bigOtterUuid = crypto.randomUUID()
    // identity 明确 big
    expect(resolveOtterVisual(bigOtterUuid, { type: 'big' }).color.hex).toBe('#8B6F47')
    // 修复前的病灶形态：不传 type 落动态色池——现在 identity 缺失走 fnv1a 回退，
    // 仍非品牌棕但稳定；名册/SSE 到位后（type=big）恒品牌棕（上条断言）
    const a1 = resolveOtterVisual(bigOtterUuid)
    const a2 = resolveOtterVisual(bigOtterUuid)
    expect(a1.color.hex).toBe(a2.color.hex)
  })

  it('两个大獭 UUID 先后到达（切对话场景）：各自身份明确时互不影响、同为品牌棕', () => {
    const bigA = crypto.randomUUID()
    const bigB = crypto.randomUUID()
    const a = resolveOtterVisual(bigA, { type: 'big' })
    const b = resolveOtterVisual(bigB, { type: 'big' })
    const a2 = resolveOtterVisual(bigA, { type: 'big' })
    expect(a.color.hex).toBe('#8B6F47')
    expect(b.color.hex).toBe('#8B6F47')
    expect(a2.color.hex).toBe(a.color.hex)
  })
})

describe('resolveOtterVisual — 三态解析', () => {
  it('identity 完整（small + 合法 key）：走色板库值', () => {
    for (const key of OTTER_PALETTE_KEYS) {
      const { color } = resolveOtterVisual('any-id', { type: 'small', color: key })
      expect(color.hex).toBe(OTTER_PALETTE_HEX[key])
    }
  })

  it('color 为 null：走 fnv1a(otterId) 展示回退——同 id 稳定、落色板内', () => {
    const id = crypto.randomUUID()
    const r1 = resolveOtterVisual(id, { type: 'small', color: null })
    const r2 = resolveOtterVisual(id, { type: 'small', color: null })
    expect(r1.color.hex).toBe(r2.color.hex)
    expect(OTTER_PALETTE_KEYS.map(k => OTTER_PALETTE_HEX[k])).toContain(r1.color.hex)
  })

  it('identity 缺失：type 按 small 回退 + fnv1a 色（跨实例稳定——刷新一致性）', () => {
    const id = crypto.randomUUID()
    const r1 = resolveOtterVisual(id)
    const r2 = resolveOtterVisual(id, undefined)
    const r3 = resolveOtterVisual(id, null)
    expect(r1.color.hex).toBe(r2.color.hex)
    expect(r2.color.hex).toBe(r3.color.hex)
    // 大獭头像判定不受影响（小獭池头像）
    expect(r1.avatar).toMatch(/^\/avatars\/otter-\d{2}-[a-z]+\.svg$/)
  })

  it('未知 color key（脏数据/未来色板变更）：回退而非炸渲染', () => {
    const { color } = resolveOtterVisual('dirty-id', { type: 'small', color: 'not-a-key' })
    expect(OTTER_PALETTE_KEYS.map(k => OTTER_PALETTE_HEX[k])).toContain(color.hex)
  })

  it('大獭：color 不参与（即便带脏 color，type=big 恒品牌棕 + datu 头像）', () => {
    const { color, avatar } = resolveOtterVisual('big-uuid', { type: 'big', color: 'teal' })
    expect(color.hex).toBe('#8B6F47')
    expect(avatar).toBe('/avatars/datu.svg')
  })
})

describe('resolveOtterVisual — 头像联动', () => {
  it('small 獭头像走九款池（hash 稳定）', () => {
    const id = crypto.randomUUID()
    const { avatar } = resolveOtterVisual(id, { type: 'small', color: 'plum' })
    expect(avatar).toMatch(/^\/avatars\/otter-\d{2}-[a-z]+\.svg$/)
  })
})
