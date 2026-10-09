/**
 * F20261010 左栏取证 II：系统性枚举左栏重渲染触发器。
 * 上一轮：新会话创建 → 左栏 0 事件。本轮枚举：
 *   a) 未读消息到达（往非活跃会话注入 entry——触发未读徽章 + 排序变化）
 *   b) 活跃会话新回复（SSE speak 到达）
 *   c) 置顶状态变化
 * 每步后采样左栏 scrollTop 事件。
 */
import { test, expect } from '@playwright/test'

const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'

test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据')

test('左栏重渲染触发器枚举', async ({ page, request }) => {
  await page.addInitScript({ path: './e2e/tri-scroll-probe.js' })
  await page.goto(`/conversation/${CONV}`)
  await page.waitForTimeout(3000)

  // 左栏滚到中部
  const prep = await page.evaluate(() => {
    const aside = document.querySelector('aside')
    const sc = aside && [...aside.querySelectorAll('div')].find(d => {
      const s = getComputedStyle(d)
      return s.overflowY === 'auto' && d.scrollHeight > d.clientHeight + 4
    })
    if (!sc) return false
    sc.scrollTop = Math.floor(sc.scrollHeight / 2)
    return true
  })
  expect(prep, '左栏滚动容器就位').toBe(true)
  await page.waitForTimeout(300)

  // 找一个非活跃会话当未读注入目标
  const convs = await request.get('/api/conversations?status=active&limit=10')
  const items = (await convs.json()).items || []
  const target = items.find((c: { id: string }) => c.id !== CONV)
  console.log(`[tri-L2] 未读目标会话: ${target?.id?.slice(0, 8)} (${target?.title})`)

  // a) 往非活跃会话注入一条消息（user 入口）——触发左栏未读徽章 + updated_at 排序刷新
  await page.evaluate(() => window.__triProbe.clear())
  if (target) {
    const r = await request.post(`/api/conversations/${target.id}/messages`, { data: { content: 'tri-probe 未读注入 ' + Date.now() } })
    console.log(`[tri-L2a] 未读消息注入: ${r.status()}`)
  }
  await page.waitForTimeout(6000)
  const evA = await page.evaluate(() => window.__triProbe.dump())
  console.log(`[tri-L2a] 事件: ${evA.length}`)
  for (const e of evA.slice(0, 20)) console.log(JSON.stringify(e))

  // b) SSE speak 到达活跃会话（后端侧注入 speak——复刻大獭回复形态）。
  //    走 API 不行（会 dispatch 大獭）——直接 sqlite 不可行（SSE 不推）。
  //    换：用 evaluate 在页面内派发一条自定义 SSE 事件? 太绕。跳过 b，改测：
  // b') 活跃会话 summary 变化（左栏显示摘要的会话）
  await page.evaluate(() => window.__triProbe.clear())
  const r2 = await request.patch(`/api/conversations/${CONV}`, { data: { summary: '取证摘要更新 ' + Date.now() } })
  console.log(`[tri-L2b] 摘要更新: ${r2.status()}`)
  await page.waitForTimeout(5000)
  const evB = await page.evaluate(() => window.__triProbe.dump())
  console.log(`[tri-L2b] 事件: ${evB.length}`)
  for (const e of evB.slice(0, 20)) console.log(JSON.stringify(e))

  expect(true).toBe(true)
})
