/**
 * F20261027cbgix：自定义背景静态 CSS 契约抽检。
 * jsdom 不渲染层叠或加载背景图；真实图片适配与玻璃观感由真浏览器验收承担。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../styles/globals.css'), 'utf-8')

describe('自定义背景静态 CSS 契约', () => {
  it('使用独立固定画布，居中铺满且不重复', () => {
    expect(css).toMatch(/:root\[data-custom-bg='true'\]\s+body::before\s*\{[^}]*position:\s*fixed/)
    expect(css).toMatch(/:root\[data-custom-bg='true'\]\s+body::before\s*\{[^}]*background-image:\s*var\(--custom-bg-image\)/)
    expect(css).toMatch(/:root\[data-custom-bg='true'\]\s+body::before\s*\{[^}]*background-size:\s*cover/)
    expect(css).toMatch(/:root\[data-custom-bg='true'\]\s+body::before\s*\{[^}]*background-position:\s*center/)
    expect(css).toMatch(/:root\[data-custom-bg='true'\]\s+body::before\s*\{[^}]*background-repeat:\s*no-repeat/)
  })

  it('body 隔离层叠使负 z-index 图片画布留在默认背景之上、内容之下', () => {
    expect(css).toMatch(/body\s*\{[^}]*isolation:\s*isolate/)
    expect(css).toMatch(/:root\[data-custom-bg='true'\]\s+body::before\s*\{[^}]*z-index:\s*-1/)
  })

  it('默认极光画布保留，reduced-transparency 仍只清默认层', () => {
    expect(css).toMatch(/\.bg-spring\s*\{[^}]*var\(--blob-1\),\s*var\(--blob-2\),\s*var\(--blob-3\),\s*var\(--blob-4\),\s*var\(--band\)/)
    expect(css).toMatch(/prefers-reduced-transparency:\s*reduce[\s\S]*?\.bg-spring\s*\{\s*background-image:\s*none/)
    expect(css).not.toMatch(/prefers-reduced-transparency:\s*reduce[\s\S]*?body::before\s*\{[^}]*background-image:\s*none/)
  })
})
