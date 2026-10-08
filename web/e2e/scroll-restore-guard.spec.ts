/**
 * F20261008w8lt e2e 护栏：真实浏览器下的「上翻 loadMore 恢复」逐帧断言。
 * 场景锚：10/8 alpha 取证 v8——loadMore 恢复把贴顶用户甩到 top=3634（滚动比例 31%）。
 * 修复后断言：msgs 增长瞬间 top 不发生 >500px 向下跳增（restore 甩出即红）。
 * 依赖 alpha 实例（E2E_BASE_URL）与复刻的 reseach 会话数据（本地 sqlite 注入）——
 * 无数据环境显式 skip（与 frame-guard 同款门控）：CI 空库下 boundingBox() 为 null、
 * 滚轮序列不执行、idx=-1 静默假绿，宁可 skip 不要假防护（检视发现 8）。
 */
import { test, expect } from '@playwright/test'
// 环境门控：无复刻会话数据时显式 skip（诚实输出，不产假绿）
test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据（E2E_REPLICA_DATA=1 + E2E_BASE_URL 指向含数据实例）')
const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'
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
  ;(() => {
    const loop = () => {
      const el = window.__findScroller()
      if (el) window.__f.push({ t: Math.round(performance.now()), top: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight), msgs: el.querySelectorAll('[data-message-id]').length })
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })()
`
test('v9: 修复后——上翻 loadMore 惯性场景重放', async ({ page }) => {
  test.setTimeout(180_000)
  await page.addInitScript(SAMPLER)
  await page.goto(`/conversation/${CONV}`)
  await page.waitForTimeout(4000)
  await page.evaluate(() => { const e2 = (window as unknown as { __findScroller: () => HTMLElement }).__findScroller(); if (e2) e2.scrollTop = e2.scrollHeight })
  await page.waitForTimeout(1500)
  const el = page.locator('[data-message-id]').first().locator('xpath=ancestor::*[contains(@class,"overflow-y-auto")][1]')
  const box = await el.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300))
  for (let i = 0; i < 35; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(25) }
  await page.waitForTimeout(15000)
  const frames = await page.evaluate(() => (window as unknown as { __f: { t: number; top: number; sh: number; msgs: number }[] }).__f)
  const idx = frames.findIndex((f, i) => i > 0 && f.msgs !== frames[i - 1].msgs)
  console.log(`[v9] msgs 变化帧 idx=${idx}：${idx > 0 ? frames[idx - 1].msgs + '→' + frames[idx].msgs : '未触发'}`)
  if (idx > 0) {
    const around = frames.slice(Math.max(0, idx - 5), idx + 15)
    for (const f of around) console.log(`  t=${f.t} top=${f.top} sh=${f.sh} msgs=${f.msgs}`)
    // 断言：msgs 增长瞬间（loadMore 恢复）top 不发生「向下跳增」（跳到中间=restore 甩出）
    const pre = frames[idx - 1], post = frames[idx]
    const jumpedDown = post.top - pre.top > 500
    console.log(`[v9] 恢复瞬间 top: ${pre.top} → ${post.top} ${jumpedDown ? '❌ 甩到中间（bug 仍在）' : '✅ 平滑/贴顶保持'}`)
    expect(jumpedDown).toBe(false)
  }
})
