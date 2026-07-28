import { describe, it, expect } from 'vitest'
import { CARD_BRIDGE_SCRIPT, CARD_ID_RE, buildCardBridgeScript } from './card-bridge'

describe('buildCardBridgeScript（桥脚本 cardId 注入）', () => {
  it('注入 cardId 且不含占位符', () => {
    const script = buildCardBridgeScript('msg-1:0')
    expect(script).not.toContain('__OTTER_CARD_ID__')
    expect(script).toContain('"msg-1:0"')
    expect(script).toContain("card:resize")
    expect(script).toContain("card:submit")
  })

  it('模板源码本身保留占位符（每次注入独立生成）', () => {
    expect(CARD_BRIDGE_SCRIPT).toContain('__OTTER_CARD_ID__')
  })
})

describe('cardId 格式闸门（fail-closed）', () => {
  it('契约格式 {messageId}:{fenceIndex} 通过：\\w 与连字符 messageId + 数字 fenceIndex', () => {
    for (const id of ['msg-1:0', 'abc_DEF:12', 'a-b_c-1:3']) {
      expect(CARD_ID_RE.test(id)).toBe(true)
      expect(buildCardBridgeScript(id)).toContain('card:submit')
    }
  })

  it('畸形 cardId 一律拒绝：退化为只 resize 版本（无 submit、不注入原值）', () => {
    for (const id of ['', 'm:', ':0', 'm:x', 'm:0:1', 'm:0x', 'a b:0', 'evil";alert(1);//']) {
      expect(CARD_ID_RE.test(id)).toBe(false)
      const script = buildCardBridgeScript(id)
      expect(script).toContain('card:resize')
      expect(script).not.toContain('card:submit')
      expect(script).not.toContain('otterCard')
      if (id) expect(script).not.toContain(id)
    }
  })

  it('脚本注入型 cardId 被闸门拦截，不产生脚本逃逸（JSON 转义路径不再可达）', () => {
    const script = buildCardBridgeScript('evil";alert(1);//')
    expect(script).not.toContain('alert')
  })
})
