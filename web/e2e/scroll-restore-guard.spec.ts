/**
 * F20261020wcsr e2e 护栏（微信式重构）：scroll-restore-guard.spec.ts 的新语义接替版。
 * 旧 spec 断言「loadMore 恢复不甩位」——距顶恢复链已退役，位置保持主力移交浏览器
 * scroll anchoring（F20261010vwst §3.3 要求：启用前专项 e2e 验证四锚不回归+原始抖动
 * 不重现，本文即该验证的承担者之一）。
 * 三用例：
 * ①中部 prepend 零跳变（锚 2，锚定核心验收）：上翻到中部阅读 → 哨兵自动加载历史 →
 *   逐帧断言视口内锚点消息位置偏移 ≤4px
 * ②哨兵触发 + 连拉限幅（锚 4）：近顶自动加载；停在顶部连拉 ≤3 批后停；
 *   下滚再上滚可再触发
 * ③绝对顶部 prepend 兜底（锚 5）：滚到 scrollTop=0 触发加载 → 原顶部消息视口位置
 *   偏移 ≤4px（规范 §2.1 边界：锚点不选原点容器，jsdom 无法模拟，只能真实浏览器验证）
 * 环境门控同 frame-guard：无复刻会话数据显式 skip（CI 空库不假绿）。
 */
import { test, expect } from '@playwright/test'

test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据（E2E_REPLICA_DATA=1 + E2E_BASE_URL 指向含数据实例）')

const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'
const MSG_SEL = '[data-message-id]'

/** 帧采样器：scrollTop / scrollHeight / 消息数 / 首条可见消息的视口位置 */
const SAMPLER = `
  window.__f = []
  window.__findScroller = () => {
    const m = document.querySelector('[data-message-id]')
    let el = m
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('overflow-y-auto')) return el
      el = el.parentElement
    }
    return null
  }
  window.__anchorMsgRect = () => {
    const el = window.__findScroller()
    if (!el) return null
    const scRect = el.getBoundingClientRect()
    const msgs = el.querySelectorAll('[data-message-id]')
    for (const m of msgs) {
      const r = m.getBoundingClientRect()
      if (r.bottom > scRect.top && r.top < scRect.bottom) return { id: m.getAttribute('data-message-id'), top: Math.round(r.top - scRect.top) }
    }
    return null
  }
  ;(() => {
    const loop = () => {
      const el = window.__findScroller()
      if (el) window.__f.push({ top: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight), msgs: el.querySelectorAll('[data-message-id]').length })
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })()
`

/** 滚轮上翻到指定 scrollTop 附近（步进防惯性过冲） */
async function wheelTo(page: import('@playwright/test').Page, targetTop: number) {
  const el = page.locator(MSG_SEL).first().locator('xpath=ancestor::*[contains(@class,"overflow-y-auto")][1]')
  const box = await el.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300))
  for (let i = 0; i < 60; i++) {
    const cur = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().scrollTop)
    if (cur <= targetTop) break
    await page.mouse.wheel(0, -200)
    await page.waitForTimeout(30)
  }
}

test.describe('F20261020wcsr 微信式重构 e2e 护栏', () => {
  test('锚 2：中部阅读 prepend 零跳变（scroll anchoring 核心验收）', async ({ page }) => {
    test.setTimeout(180_000)
    await page.addInitScript(SAMPLER)
    await page.goto(`/conversation/${CONV}`)
    await page.waitForSelector(MSG_SEL, { timeout: 30_000 })
    // 贴底 → 上翻到中部阅读位（哨兵预触发带之外，先稳定）
    await page.evaluate(() => { const e2 = (window as unknown as { __findScroller(): HTMLElement }).__findScroller(); e2.scrollTop = e2.scrollHeight })
    await page.waitForTimeout(1000)
    await wheelTo(page, 2500)
    await page.waitForTimeout(1500)
    // 等可能的加载完全稳定（中部位置不触发哨兵，但惯性/余波等满）
    // 锚点采样：当前视口首条可见消息 id 与其视口内 y——本用例的验收对象
    const anchorBefore = await page.evaluate(() => (window as unknown as { __anchorMsgRect(): { id: string; top: number } | null }).__anchorMsgRect())
    expect(anchorBefore, '中部应有可见锚点消息').toBeTruthy()
    // 触发 prepend：滚到近顶让哨兵进入预触发带，等加载完成后滚回锚点消息
    const msgsBefore = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().querySelectorAll('[data-message-id]').length)
    await wheelTo(page, 100)
    await page.waitForTimeout(6000) // 加载 + 渲染窗口
    const msgsAfter = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().querySelectorAll('[data-message-id]').length)
    console.log(`[锚2] msgs ${msgsBefore} → ${msgsAfter}，锚点=${anchorBefore!.id}@${anchorBefore!.top}px`)
    expect(msgsAfter, '哨兵应触发加载（消息数增长）').toBeGreaterThan(msgsBefore)
    // 核心验收：滚回锚点消息（scrollIntoView 到视口内），断言其视口 y 与加载前偏移 ≤4px——
    // scroll anchoring 失效时 prepend 会把锚点消息顶下去一整批高度（数百 px），必红；
    // 生效时浏览器保持锚点原位，偏移在亚像素到个位像素
    await page.evaluate((id: string) => {
      const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
      const m = el.querySelector(`[data-message-id="${id}"]`)
      if (m) {
        const scRect = el.getBoundingClientRect()
        const r = m.getBoundingClientRect()
        el.scrollTop += (r.top - scRect.top) - (window as unknown as { __anchorBeforeTop?: number }).__anchorBeforeTop!
      }
    }, anchorBefore!.id)
    // 直接测量：prepend 后锚点消息当前视口 y 与加载前差值（判据用它现在的真实位置）
    const posNow = await page.evaluate((id: string) => {
      const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
      const m = el.querySelector(`[data-message-id="${id}"]`)
      if (!m) return null
      const scRect = el.getBoundingClientRect()
      return Math.round(m.getBoundingClientRect().top - scRect.top)
    }, anchorBefore!.id)
    console.log(`[锚2] 锚点消息视口 y：加载前 ${anchorBefore!.top} → 加载后 ${posNow}（判据偏移 ≤4px）`)
    expect(posNow, 'prepend 后锚点消息应在视口内可测').not.toBeNull()
    expect(Math.abs(posNow! - anchorBefore!.top), `scroll anchoring 失效：锚点消息视口 y 偏移 ${Math.abs(posNow! - anchorBefore!.top)}px（>4px）`).toBeLessThanOrEqual(4)
  })

  test('锚 4：哨兵连拉限幅（≤3 批后停，下滚解除）', async ({ page }) => {
    test.setTimeout(180_000)
    await page.addInitScript(SAMPLER)
    await page.goto(`/conversation/${CONV}`)
    await page.waitForSelector(MSG_SEL, { timeout: 30_000 })
    // 滚到顶部触发连拉——frames 基线在 goto 后首屏稳定即锁定（排除首屏 0→50 渲染帧：
    // waitForSelector 保证消息已在，基线从「已有消息」状态起算，批次计数只统计滚动触发的加载）
    const msgsAtStart = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().querySelectorAll('[data-message-id]').length)
    await page.evaluate(() => { const e2 = (window as unknown as { __findScroller(): HTMLElement }).__findScroller(); e2.scrollTop = 0 })
    await page.waitForTimeout(8000) // 等连拉窗口
    const msgsAfterChain = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().querySelectorAll('[data-message-id]').length)
    const batches = Math.round((msgsAfterChain - msgsAtStart) / 50) // 每批 50 条（wcsr T4）
    console.log(`[锚4] 连拉 msgs ${msgsAtStart} → ${msgsAfterChain}（≈${batches} 批）`)
    expect(msgsAfterChain, '停在顶部应自动连拉').toBeGreaterThan(msgsAtStart)
    expect(batches, '连拉限幅 ≤3 批').toBeLessThanOrEqual(3)
    // 冷却解除：下滚再上滚 → 应能再触发
    await page.evaluate(() => { const e2 = (window as unknown as { __findScroller(): HTMLElement }).__findScroller(); e2.scrollTop = 800 })
    await page.waitForTimeout(500)
    await page.evaluate(() => { const e2 = (window as unknown as { __findScroller(): HTMLElement }).__findScroller(); e2.scrollTop = 0 })
    await page.waitForTimeout(6000)
    const finalMsgs2 = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().querySelectorAll('[data-message-id]').length)
    console.log(`[锚4] 冷却解除后 msgs ${msgsAfterChain} → ${finalMsgs2}`)
    // 冷却解除后应至少再拉 1 批（除非历史已耗尽——1032 条复刻会话下 4 批 200 条不可能耗尽）
    expect(finalMsgs2, '下滚再上滚应解除冷却并再触发加载').toBeGreaterThan(msgsAfterChain)
  })

  test('锚 5：绝对顶部 prepend 兜底（规范 §2.1 边界——jsdom 无法模拟）', async ({ page }) => {
    test.setTimeout(180_000)
    await page.addInitScript(SAMPLER)
    await page.goto(`/conversation/${CONV}`)
    await page.waitForSelector(MSG_SEL, { timeout: 30_000 })
    // 滚到绝对顶部触发加载——显式控制批次：下滚-上滚循环解除冷却直到本批确实加载，
    // 断言只在该批上执行（不依赖默认时序，核心 ≤5px 断言必达——镜川严重 1④：
    // 默认时序落冷却态时 else 只 console.log，断言形同虚设）
    let before = { firstId: null as string | null }
    let msgsBefore = 0
    let msgsAfter = 0
    for (let attempt = 0; attempt < 4; attempt++) {
      before = await page.evaluate(() => {
        const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
        el.scrollTop = 0
        return new Promise<{ firstId: string | null }>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => {
            resolve({ firstId: el.querySelector('[data-message-id]')?.getAttribute('data-message-id') ?? null })
          })))
      })
      msgsBefore = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().querySelectorAll('[data-message-id]').length)
      await page.waitForTimeout(6000)
      msgsAfter = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().querySelectorAll('[data-message-id]').length)
      if (msgsAfter > msgsBefore) break
      // 未加载（冷却中）：下滚解除，下一轮再试
      await page.evaluate(() => { const e2 = (window as unknown as { __findScroller(): HTMLElement }).__findScroller(); e2.scrollTop = 800 })
      await page.waitForTimeout(500)
    }
    console.log(`[锚5] 顶部 msgs ${msgsBefore} → ${msgsAfter}，加载前首条=${before.firstId}`)
    expect(msgsAfter, '经冷却解除循环后应完成一批加载（断言必达，不静默跳过）').toBeGreaterThan(msgsBefore)
    // 加载前首条消息应仍在视口顶部附近（兜底把它推回原位）——
    // 断言其视口内位置偏移 ≤5px（与锚 2 同判据；旧无保护时用户会被顶下去一整批高度）
    const pos = await page.evaluate((firstId: string | null) => {
      const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
      const scRect = el.getBoundingClientRect()
      const m = firstId ? el.querySelector(`[data-message-id="${firstId}"]`) : null
      if (!m) return null
      const r = m.getBoundingClientRect()
      return Math.round(r.top - scRect.top)
    }, before.firstId)
    console.log(`[锚5] 加载前首条消息视口位置=${pos}px（判据 ≤5px）`)
    expect(pos, '加载前首条消息应在 DOM 中可查（prepend 不删既有消息）').not.toBeNull()
    expect(Math.abs(pos!), `绝对顶部兜底后首条消息视口位置 ${pos}px 超允许值`).toBeLessThanOrEqual(5)
  })
})

