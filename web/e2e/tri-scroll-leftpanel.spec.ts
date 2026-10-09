/**
 * F20261010 三层滚动取证 III：左栏自更新场景。
 * 搭档现场补充：左栏「对话列表」自己跳动。假设：SSE 事件（新会话/未读/排序变化）
 * 触发左栏列表重渲染，某些项高度变化（未读徽章出现/消失、标题换行数变化）导致
 * 滚动锚丢失 → 浏览器对 scrollTop 做 clamp → 左栏「跳」。
 * 方法：挂探针 → 左栏滚到中部（阅读位置）→ API 造一个新会话（触发左栏刷新）→ 采样。
 */
import { test, expect } from '@playwright/test'

const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'

test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据')

test('左栏自更新场景：新会话到达时左栏跳不跳', async ({ page, request }) => {
  await page.addInitScript({ path: './e2e/tri-scroll-probe.js' })
  await page.goto(`/conversation/${CONV}`)
  await page.waitForTimeout(3000)

  // 左栏滚到中部（模拟搭档正在浏览列表）——直接找 aside 内 overflow 容器
  const leftMoved = await page.evaluate(() => {
    const aside = document.querySelector('aside')
    if (!aside) return 'no-aside'
    const sc = [...aside.querySelectorAll('div')].find(d => {
      const s = getComputedStyle(d)
      return s.overflowY === 'auto' && d.scrollHeight > d.clientHeight + 4
    })
    if (!sc) return 'no-scroller'
    sc.scrollTop = Math.floor(sc.scrollHeight / 2)
    return `scrolled-to-${Math.floor(sc.scrollHeight / 2)} (sh=${sc.scrollHeight})`
  })
  console.log(`[tri-L0] 左栏定位: ${leftMoved}`)
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__triProbe.clear())

  // 造一个新会话（POST /api/conversations）→ SSE 推送 → 左栏列表重渲染
  const r = await request.post('/api/conversations', { data: { title: 'tri-probe-新会话-' + Date.now() } })
  console.log(`[tri-L0] 新会话创建: ${r.status()}`)
  await page.waitForTimeout(8000) // 等 SSE + 重渲染 + 可能的动画

  const events = await page.evaluate(() => window.__triProbe.dump())
  console.log(`[tri-L1] 事件数: ${events.length}`)
  for (const e of events.slice(0, 30)) console.log(JSON.stringify(e))
  const byLayer = {}
  for (const e of events) byLayer[e.k] = (byLayer[e.k] || 0) + 1
  console.log(`[tri-L1] 分层: ${JSON.stringify(byLayer)}`)

  expect(true).toBe(true)
})
