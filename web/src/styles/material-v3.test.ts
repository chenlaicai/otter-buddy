/**
 * F20261102glmtr：材质体系 v3.0 静态 CSS 契约——分层材质学说落地。
 *
 * 学说（R20261102glass）：闪动可见度 = 实时重采样(R) × 覆盖(C) × 嵌套(N)，
 * R→0（常驻层零 backdrop-filter）是唯一严格不闪保证。本测试锁定：
 *   1. 常驻层 5 token 全部置 none（chrome/panel/card/bubble/form-input）
 *   2. 瞬态/遮罩层 2 token 保留（overlay/scrim）——防误伤真玻璃
 *   3. Mica 薄纱规则：var 带 fallback、无 backdrop-filter
 *   4. 六轮弹窗终局语义不被破坏（与 scrim-flicker-6 互补）
 *   5. 瞬态层白名单闭合（浮动助手 utility 在位 + 窄屏按钮不引用 .glass-overlay）
 *
 * jsdom 不渲染层叠；真实观感由真浏览器验收（方案「验证」节 7 项）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../styles/globals.css'), 'utf-8')
// __dirname = web/src/styles → 仓库根 = ../../..（从 styles 出发：styles→src→web→根）
const readSrc = (rel: string) => readFileSync(resolve(__dirname, '../../../', rel), 'utf-8')

describe('材质 v3.0 契约：常驻层零实时采样（R=0）', () => {
  it('常驻层 5 个 blur token 全部置 none', () => {
    expect(css).toMatch(/--chrome-blur:\s*none/)
    expect(css).toMatch(/--panel-blur:\s*none/)
    expect(css).toMatch(/--card-blur:\s*none/)
    expect(css).toMatch(/--bubble-blur:\s*none/)
    expect(css).toMatch(/--form-input-blur:\s*none/)
  })

  it('常驻类规则块不残留实时采样声明（含 -webkit- 前缀）', () => {
    for (const cls of ['.glass-strong', '.glass', '.glass-card', '.glass-input', '.form-input']) {
      // 仅匹配「类名 + 空白 + {」，避免误伤 .glass-input:focus-within 等扩展选择器
      const block = css.match(new RegExp(`${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`))
      expect(block, `${cls} 规则块应存在`).toBeTruthy()
      expect(block![0], `${cls} 不应含 backdrop-filter`).not.toMatch(/backdrop-filter/)
    }
  })

  it('气泡类（.bubble-otter）无实时采样——身份色染保留', () => {
    const block = css.match(/\.bubble-otter\s*\{[^}]*\}/)
    expect(block).toBeTruthy()
    expect(block![0]).not.toMatch(/backdrop-filter/)
    // 身份色染不能被顺手摘掉（观感保级 T3）
    expect(block![0]).toMatch(/--otter-tint/)
  })
})

describe('材质 v3.0 契约：瞬态/遮罩层真玻璃保留（白名单闭合）', () => {
  it('瞬态与遮罩 blur token 保留（防「一刀切全 none」误伤）', () => {
    expect(css).toMatch(/--overlay-blur:\s*blur\(40px\)\s*saturate\(180%\)/)
    expect(css).toMatch(/--scrim-blur:\s*blur\(6px\)/)
    expect(css).toMatch(/\.glass-overlay\s*\{[^}]*backdrop-filter:\s*var\(--overlay-blur\)/)
    expect(css).toMatch(/\.scrim\s*\{[^}]*backdrop-filter:\s*var\(--scrim-blur\)/)
  })

  it('浮动助手面板保留瞬态模糊（全仓反向闭合）', () => {
    // F20261103lglct：浮动獭小面升级为静态画布折射，不再采样真实 DOM；面板仍保留模糊。
    expect(readSrc('web/src/components/FloatingAssistant/AssistantPanel.tsx')).toMatch(/backdrop-blur/)
    expect(readSrc('web/src/components/FloatingAssistant/FloatingOtter.tsx')).not.toMatch(/backdrop-blur/)
    // 豁免均属弹层/抽屉瞬态（WorkDetailDialog/ChainDetailDrawer/im 覆盖确认）。
    const exempt = new Set([
      'components/FloatingAssistant/AssistantPanel.tsx',
      'pages/health/WorkDetailDialog.tsx',
      'pages/health/ChainDetailDrawer.tsx',
      'pages/im/index.tsx',
    ])
    const srcRoot = resolve(__dirname, '..') // web/src
    const violations: string[] = []
    const scan = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, e.name)
        if (e.isDirectory()) { scan(full); continue }
        if (!e.name.endsWith('.tsx')) continue
        const rel = resolve(srcRoot, full).replace(srcRoot + '/', '')
        if (exempt.has(rel)) continue
        if (/\bbackdrop-blur[-a-z0-9]*\b/.test(readFileSync(full, 'utf-8'))) violations.push(rel)
      }
    }
    scan(srcRoot)
    expect(violations, `白名单外不得使用 backdrop-blur utility：${violations.join(', ')}`).toEqual([])
  })

  it('窄屏抽屉开关钮不再引用 .glass-overlay（常驻面禁采样，改 .drawer-fab）', () => {
    const index = readSrc('web/src/pages/conversation/index.tsx')
    // 两处 <lg/<md 常驻 FAB 均用实色 drawer-fab
    expect(index).not.toMatch(/glass-overlay flex items-center justify-center/)
    expect((index.match(/drawer-fab/g) ?? []).length).toBe(2)
    // .drawer-fab 实色类存在于 globals.css 且无采样
    const fab = css.match(/\.drawer-fab\s*\{[^}]*\}/)
    expect(fab, '.drawer-fab 规则块应存在').toBeTruthy()
    expect(fab![0]).not.toMatch(/backdrop-filter/)
  })

  it('非测试组件代码无内联 backdropFilter（S1 整类清零）', () => {
    const files = [
      'web/src/pages/conversation/SessionModal.tsx',
      'web/src/components/Modal.tsx',
    ]
    for (const f of files) {
      expect(readSrc(f), `${f} 不应含内联 backdropFilter`).not.toMatch(/backdropFilter/)
    }
  })
})

describe('材质 v3.0 契约：Mica 薄纱（画布层静态合成）', () => {
  it('薄纱规则块在位：选择器形态锁定 + 无实时采样（检视獭-impl S7 补①③）', () => {
    const veil = css.match(/:root\[data-custom-bg='true'\]\s+body::before\s*\{[^}]*\}/)
    expect(veil, '薄纱规则块应存在于 globals.css').toBeTruthy()
    expect(veil![0], '薄纱是静态合成，不得含 backdrop-filter').not.toMatch(/backdrop-filter/)
    expect(veil![0]).toMatch(/background-image:/)
  })

  it('薄纱 var 必带 fallback（防 var 未定义期整条声明 invalid 致背景图消失）', () => {
    expect(css).toMatch(/rgba\(var\(--canvas-tint-rgb,\s*250,\s*247,\s*238\),\s*0\.32\)/)
  })

  it('主色提取注入与清除（background-preference.ts）', () => {
    const src = readSrc('web/src/lib/background-preference.ts')
    // 中性纱兜底先落（applyDecodedBackground 同步），再异步换真主色
    expect(src).toMatch(/--canvas-tint-rgb/)
    expect(src).toMatch(/NEUTRAL_TINT_RGB/)
    expect(src).toMatch(/extractDominantTint/)
    // 清除路径同步清 var
    expect(src).toMatch(/removeProperty\('--canvas-tint-rgb'\)/)
  })
})

describe('材质 v3.0 契约：六轮弹窗终局不被破坏', () => {
  it('modal-open 内容自模糊（var(--scrim-blur)）+ scrim 语义共存（F20260909scrf6）', () => {
    expect(css).toMatch(/body\.modal-open \[data-testid='app-content-scroll'\] \{ filter: var\(--scrim-blur\)/)
    expect(css).toMatch(/body\.modal-open \.scrim \{ backdrop-filter: none/)
    expect(css).toMatch(/\.scrim\s*\{[^}]*var\(--scrim-blur\)/)
  })
})
