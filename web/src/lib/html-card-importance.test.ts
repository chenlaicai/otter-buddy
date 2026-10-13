import { describe, it, expect } from 'vitest'
import { parseCardImportance, extractFoldedSummary, CARD_FOLDED_SUMMARY_MAX_CHARS } from './html-card'

/**
 * F20261013csv3 T3/T4：html-card meta 扩展单测。
 * T4 importance：high 默认展开 / normal 默认折叠；解析失败按 normal（绝不抛错）。
 * T3 折叠态摘要行：跳过 script/style/textarea；纯标点视同空；截断至 120 字符。
 */

describe('parseCardImportance（T4）', () => {
  it('importance="high" → high', () => {
    expect(parseCardImportance('title="简报" importance="high"')).toBe('high')
  })
  it('缺省 → normal', () => {
    expect(parseCardImportance('title="普通卡"')).toBe('normal')
    expect(parseCardImportance(null)).toBe('normal')
    expect(parseCardImportance(undefined)).toBe('normal')
  })
  it('非法值 → normal（降级安全方向是折叠）', () => {
    expect(parseCardImportance('importance="urgent"')).toBe('normal')
    expect(parseCardImportance('importance=""')).toBe('normal')
  })
  it('解析失败不抛错（畸形 meta）', () => {
    expect(parseCardImportance('importance=high')).toBe('normal') // 无双引号
    expect(parseCardImportance('importance="high')).toBe('normal') // 未闭合
  })
  it('与 title 混排不受影响', () => {
    expect(parseCardImportance('importance="high" title="x"')).toBe('high')
    expect(parseCardImportance('title="x" importance="high" card="1:2"')).toBe('high')
  })
})

describe('extractFoldedSummary（T3）', () => {
  it('提取首个非空文本片段（块级首行）', () => {
    const html = `<div><h2>结论</h2><p>推荐方案 B：沙箱 iframe + 预算 3 天</p></div>`
    expect(extractFoldedSummary(html)).toBe('结论')
  })
  it('跳过 <script>/<style>/<textarea> 内容', () => {
    const html = `<style>.x{color:red}</style><script>const x = 1; console.log(x)</script><textarea>hidden</textarea><p>可见文本</p>`
    expect(extractFoldedSummary(html)).toBe('可见文本')
  })
  it('纯标点行视同空，取下一个有效行', () => {
    const html = `<div>---</div><div>===</div><p>有效内容</p>`
    expect(extractFoldedSummary(html)).toBe('有效内容')
  })
  it('截断至 CARD_FOLDED_SUMMARY_MAX_CHARS 字符', () => {
    const long = '长'.repeat(CARD_FOLDED_SUMMARY_MAX_CHARS + 50)
    const html = `<p>${long}</p>`
    const summary = extractFoldedSummary(html)
    expect(summary).not.toBeNull()
    expect(summary!.length).toBe(CARD_FOLDED_SUMMARY_MAX_CHARS)
    expect(summary!.endsWith('…')).toBe(true)
  })
  it('HTML 实体解码（&amp; &lt; 等）', () => {
    expect(extractFoldedSummary(`<p>A &amp; B &lt;test&gt;</p>`)).toBe('A & B <test>')
  })
  it('无有效文本 → null', () => {
    expect(extractFoldedSummary(`<style>body{}</style><script>x()</script>`)).toBeNull()
    expect(extractFoldedSummary(``)).toBeNull()
    expect(extractFoldedSummary(`<div>---</div><div>***</div>`)).toBeNull()
  })
})
