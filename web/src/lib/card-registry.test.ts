import { describe, it, expect } from 'vitest'
import { registerCard, unregisterCard, getCardIdByWindow, getCardEntry } from './card-registry'

/** 伪造 contentWindow（registry 只用它做 Map 键与相等性判断） */
const fakeWindow = () => ({}) as Window

describe('card-registry（iframe 注册表）', () => {
  it('register/unregister 往返：登记可查，清理后消失', () => {
    const win = fakeWindow()
    registerCard({ cardId: 'm:0', authorId: 'otter-1', contentWindow: win })
    expect(getCardIdByWindow(win)).toBe('m:0')
    expect(getCardEntry('m:0')?.authorId).toBe('otter-1')
    unregisterCard('m:0', win)
    expect(getCardIdByWindow(win)).toBeUndefined()
    expect(getCardEntry('m:0')).toBeUndefined()
  })

  it('window 不匹配时 cleanup 拒绝清理（同 cardId 重挂载的新 iframe 不被旧 cleanup 误删）', () => {
    const oldWin = fakeWindow()
    const newWin = fakeWindow()
    registerCard({ cardId: 'm:1', authorId: 'o', contentWindow: oldWin })
    // 同 cardId 重挂载：新 iframe 覆盖登记，旧 window 反向映射同步清除
    registerCard({ cardId: 'm:1', authorId: 'o', contentWindow: newWin })
    expect(getCardIdByWindow(oldWin)).toBeUndefined()
    // 旧 iframe 的 cleanup 迟到：不得删掉新条目
    unregisterCard('m:1', oldWin)
    expect(getCardIdByWindow(newWin)).toBe('m:1')
    expect(getCardEntry('m:1')).toBeDefined()
    // 新 iframe 正常清理
    unregisterCard('m:1', newWin)
    expect(getCardEntry('m:1')).toBeUndefined()
  })

  it('unregister 不存在的卡片：静默不报错', () => {
    expect(() => unregisterCard('ghost:0', fakeWindow())).not.toThrow()
  })
})
