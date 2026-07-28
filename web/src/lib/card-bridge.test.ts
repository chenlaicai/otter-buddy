import { describe, it, expect } from 'vitest'
import { CARD_BRIDGE_SCRIPT, buildCardBridgeScript } from './card-bridge'

describe('buildCardBridgeScript（桥脚本 cardId 注入）', () => {
  it('注入 cardId 且不含占位符', () => {
    const script = buildCardBridgeScript('msg-1:0')
    expect(script).not.toContain('__OTTER_CARD_ID__')
    expect(script).toContain('"msg-1:0"')
    expect(script).toContain("card:resize")
    expect(script).toContain("card:submit")
  })

  it('cardId 含引号时经 JSON.stringify 转义，不产生脚本逃逸', () => {
    const script = buildCardBridgeScript('evil";alert(1);//')
    expect(script).toContain('"evil\\";alert(1);//"')
  })

  it('模板源码本身保留占位符（每次注入独立生成）', () => {
    expect(CARD_BRIDGE_SCRIPT).toContain('__OTTER_CARD_ID__')
  })
})
