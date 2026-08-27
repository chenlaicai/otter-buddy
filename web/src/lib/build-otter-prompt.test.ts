import { describe, it, expect } from 'vitest'
import { buildOtterSystemPrompt } from './build-otter-prompt'

/**
 * F20260827ucrt：引导生成模板结构断言。
 * 只锁结构（三段式：身份/职责/协作约定）不锁措辞——文案实现时细化。
 */
describe('buildOtterSystemPrompt', () => {
  it('完整输入生成三段式结构（身份/职责/协作约定）', () => {
    const prompt = buildOtterSystemPrompt({
      name: '分析獭',
      roleName: '审查獭',
      responsibilities: ['从用户体验角度分析', '关注易用性'],
    })

    // 段 1：身份
    expect(prompt).toContain('你是分析獭')
    expect(prompt).toContain('审查獭')

    // 段 2：职责（每条一行）
    expect(prompt).toContain('职责：')
    expect(prompt).toContain('- 从用户体验角度分析')
    expect(prompt).toContain('- 关注易用性')

    // 段 3：协作约定（三行骨架）
    expect(prompt).toContain('协作约定：')
    expect(prompt).toContain('交回召唤者')
    expect(prompt).toContain('不编造')
    expect(prompt).toContain('先结论后细节')
  })

  it('无角色名时身份段只有名称（不含角色名）', () => {
    const prompt = buildOtterSystemPrompt({ name: '小帮手' })
    expect(prompt).toContain('你是小帮手。')
    // 身份段无逗号（未拼接角色名）——首行断言
    expect(prompt.split('\n')[0]).toBe('你是小帮手。')
    expect(prompt).not.toContain('职责：')
  })

  it('职责空白行被过滤（只留非空条目）', () => {
    const prompt = buildOtterSystemPrompt({
      name: 'X',
      responsibilities: ['有效职责', '   ', '', '另一条'],
    })
    expect(prompt).toContain('- 有效职责')
    expect(prompt).toContain('- 另一条')
    // 职责段：位于「职责：」与「协作约定：」之间，只含 2 条（空白行被过滤）
    const dutiesBlock = prompt.split('职责：')[1]?.split('协作约定：')[0] ?? ''
    expect(dutiesBlock.match(/^- /gm)?.length).toBe(2)
  })

  it('名称与角色名两侧空白被 trim', () => {
    const prompt = buildOtterSystemPrompt({ name: '  分析獭  ', roleName: ' 审查獭 ' })
    expect(prompt).toContain('你是分析獭，审查獭。')
  })

  it('协作约定段始终存在（即使无职责）', () => {
    const prompt = buildOtterSystemPrompt({ name: 'X' })
    expect(prompt).toContain('协作约定：')
  })
})
