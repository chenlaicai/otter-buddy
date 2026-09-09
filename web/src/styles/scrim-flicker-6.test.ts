/**
 * F20260909scrf6：弹窗期模糊语义切换的样式契约测试。
 * 背景：backdrop-filter 实时采样下层位图，任何漏网变化源（流式计时器等）都会
 * 造成「清晰帧↔模糊帧」跳变闪烁——白名单冻结补 5 轮仍漏网。
 * 修复：body.modal-open 期间内容区自模糊（filter:blur）+ scrim 摘掉 backdrop-filter。
 * 本测试锁定 globals.css 中这两条规则的共存，防止回退引入旧语义。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../styles/globals.css'), 'utf-8')

describe('F20260909scrf6：弹窗期内容自模糊样式契约', () => {
  it('modal-open 期间内容区挂 filter:blur（等效 scrim 模糊 token）', () => {
    expect(css).toMatch(
      /body\.modal-open\s+\[data-testid='app-content-scroll'\]\s*\{\s*filter:\s*var\(--scrim-blur\)/
    )
  })

  it('modal-open 期间 scrim 摘掉 backdrop-filter（不再实时采样）', () => {
    expect(css).toMatch(
      /body\.modal-open\s+\.scrim\s*\{\s*backdrop-filter:\s*none/
    )
  })

  it('reduced-transparency 下内容区不加模糊（无障碍全实色语义不回归）', () => {
    expect(css).toMatch(
      /prefers-reduced-transparency:\s*reduce[\s\S]*?body\.modal-open\s+\[data-testid='app-content-scroll'\]\s*\{\s*filter:\s*none/
    )
  })

  it('旧降级开关注释已退役（防双语义并存）', () => {
    expect(css).not.toMatch(/\/\*\s*body\.modal-open\s+\.scrim\s*\{\s*backdrop-filter:\s*none[^}]*\}\s*\*\//)
  })
})
