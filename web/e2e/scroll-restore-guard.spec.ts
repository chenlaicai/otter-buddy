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

test.describe('F20261020wcsr 微信式重构 e2e 护栏', () => {
  test('锚 2：中部阅读 prepend 零跳变（scroll anchoring 核心验收）', async ({ page }) => {
    test.setTimeout(180_000)
    await page.addInitScript(SAMPLER)
    await page.goto(`/conversation/${CONV}`)
    await page.waitForSelector(MSG_SEL, { timeout: 30_000 })
    // 执行验证发现的编排范式（alpha 复刻实证 + 探针归因）：连拉/冷却的存在使「先避开再触发」
    // 的编排必然踩冷却点（prepend 在 wheel 途中自然发生，采样时已是第 3 批后冷却态）。
    // 正确范式与锚 5 同型：冷却解除循环 + 批完成才采样断言——差异只在采样位置：
    // 锚 2 停在近顶阅读位（scrollTop ≈ 100-300，浏览器锚定工作区），锚 5 停在绝对顶（手写兜底区）。
    const scrollerLoc = page.locator(MSG_SEL).first().locator('xpath=ancestor::*[contains(@class,"overflow-y-auto")][1]')
    const box = await scrollerLoc.boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.wheel(0, -100) // 脱锚（pinned 贴底会覆盖后续手动 scrollTop）
    await page.waitForTimeout(200)

    let anchor = { id: null as string | null, y: null as number | null }
    let msgsBefore = 0
    let msgsAfter = 0
    for (let attempt = 0; attempt < 5; attempt++) {
      // msgsBefore 采样必须在 scrollTop=150 写入**之前**（探针实证：写入后哨兵立即在带内，
      // IO 在等待窗内就触发加载，采样在加载后 → msgsBefore=msgsAfter 误判「未加载」）
      msgsBefore = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().querySelectorAll('[data-message-id]').length)
      // 停在近顶阅读位（预触发带内但非绝对顶——锚定可选锚点的工作区）
      await page.evaluate(() => { const e2 = (window as unknown as { __findScroller(): HTMLElement }).__findScroller(); e2.scrollTop = 150 })
      await page.waitForTimeout(300) // 写入落帧即可，不等加载（加载正是要观测的事件）
      // 锚点采样（prepend 发生前最后一帧的视口首条完整可见消息）
      anchor = await page.evaluate(() => {
        const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
        const scRect = el.getBoundingClientRect()
        const msgs = el.querySelectorAll('[data-message-id]')
        for (const m of msgs) {
          const r = m.getBoundingClientRect()
          if (r.bottom > scRect.top && r.top < scRect.bottom) {
            return { id: m.getAttribute('data-message-id'), y: Math.round(r.top - scRect.top) }
          }
        }
        return { id: null, y: null }
      })
      await page.waitForTimeout(6000)
      msgsAfter = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().querySelectorAll('[data-message-id]').length)
      if (msgsAfter > msgsBefore) break
      // 冷却中：下滚解除（程序写入亦触发 handleScroll 向下位移解除），下一轮再试
      await page.evaluate(() => { const e2 = (window as unknown as { __findScroller(): HTMLElement }).__findScroller(); e2.scrollTop = 800 })
      await page.waitForTimeout(500)
    }
    console.log(`[锚2] msgs ${msgsBefore} → ${msgsAfter}，锚点=${anchor.id}@y=${anchor.y}px`)
    expect(msgsAfter, '经冷却解除循环后应完成一批加载（断言必达）').toBeGreaterThan(msgsBefore)
    expect(anchor.id, '近顶应有可见锚点消息').not.toBeNull()
    // 核心验收：prepend 后锚点消息视口 y 与加载前偏移 ≤4px——直接测，无滚回。
    // 锚定生效：浏览器在 prepend 的 layout 轮次把 scrollTop 补偿高度增量，锚点消息视口位置不变；
    // 失效：scrollTop 不变而上方插入一批高度，锚点消息被顶出视口（y 偏移数百 px 或直接离屏）
    const posNow = await page.evaluate((id: string) => {
      const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
      const m = el.querySelector(`[data-message-id="${id}"]`)
      if (!m) return null
      const scRect = el.getBoundingClientRect()
      return Math.round(m.getBoundingClientRect().top - scRect.top)
    }, anchor.id!)
    console.log(`[锚2] 锚点消息视口 y：加载前 ${anchor.y} → 加载后 ${posNow}（判据偏移 ≤4px）`)
    expect(posNow, 'prepend 后锚点消息应在 DOM 可查').not.toBeNull()
    expect(Math.abs(posNow! - anchor.y!), `scroll anchoring 失效：锚点消息视口 y 偏移 ${Math.abs(posNow! - anchor.y!)}px（>4px）`).toBeLessThanOrEqual(4)
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
    let before = { firstId: null as string | null, firstY: null as number | null }
    let msgsBefore = 0
    let msgsAfter = 0
    for (let attempt = 0; attempt < 4; attempt++) {
      before = await page.evaluate(() => {
        const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
        el.scrollTop = 0
        return new Promise<{ firstId: string | null; firstY: number | null }>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const first = el.querySelector('[data-message-id]')
            const scRect = el.getBoundingClientRect()
            resolve({
              firstId: first?.getAttribute('data-message-id') ?? null,
              // 基线 y 必须采样（执行验证发现：scrollTop=0 时视口顶部有哨兵+加载按钮占位 ≈53px，
              // 首条消息的 y 本来就不是 0——判据是绝对值≤5px 会系统性误红，正确判据是前后偏移）
              firstY: first ? Math.round(first.getBoundingClientRect().top - scRect.top) : null,
            })
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
    console.log(`[锚5] 顶部 msgs ${msgsBefore} → ${msgsAfter}，加载前首条=${before.firstId}@y=${before.firstY}`)
    expect(msgsAfter, '经冷却解除循环后应完成一批加载（断言必达，不静默跳过）').toBeGreaterThan(msgsBefore)
    // 加载前首条消息应仍在视口原位置（兜底把它推回）——判据是前后 y 偏移 ≤5px（非绝对值：
    // scrollTop=0 时首条 y=哨兵+按钮占位高，本身非零）；旧无保护时用户会被顶下去一整批高度
    const pos = await page.evaluate((firstId: string | null) => {
      const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
      const scRect = el.getBoundingClientRect()
      const m = firstId ? el.querySelector(`[data-message-id="${firstId}"]`) : null
      if (!m) return null
      const r = m.getBoundingClientRect()
      return Math.round(r.top - scRect.top)
    }, before.firstId)
    console.log(`[锚5] 首条消息视口 y：加载前 ${before.firstY} → 加载后 ${pos}（判据偏移 ≤5px）`)
    expect(pos, '加载前首条消息应在 DOM 中可查（prepend 不删既有消息）').not.toBeNull()
    expect(before.firstY, '加载前首条基线 y 应已采样').not.toBeNull()
    expect(Math.abs(pos! - before.firstY!), `绝对顶部兜底后首条消息视口 y 偏移 ${Math.abs(pos! - before.firstY!)}px 超允许值`).toBeLessThanOrEqual(5)
  })
})

