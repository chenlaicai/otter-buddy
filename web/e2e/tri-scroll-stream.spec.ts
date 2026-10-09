/**
 * F20261010 三层滚动取证 II：流式场景。
 * 模拟搭档现场：正在看最新消息（贴底），大獭回复持续到达，
 * 回复里带 play 卡（#1377 默认展开，iframe 高度桥回写触发高度突变）。
 */
import { test, expect } from '@playwright/test'

const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'

test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据')

test('流式回复 + play 卡场景：三层谁在跳', async ({ page }) => {
  await page.addInitScript({ path: './e2e/tri-scroll-probe.js' })
  await page.goto(`/conversation/${CONV}`)
  await page.waitForTimeout(3000)

  // 贴底（模拟搭档「正在看最新消息」）
  await page.evaluate(() => {
    const msg = document.querySelector('[data-message-id]')
    let sc = msg
    while (sc && sc !== document.documentElement) {
      const s = getComputedStyle(sc)
      if (/(auto|scroll)/.test(s.overflowY) && sc.scrollHeight > sc.clientHeight + 4) {
        sc.scrollTop = sc.scrollHeight
        break
      }
      sc = sc.parentElement
    }
    window.__triProbe.clear()
  })

  // 直接 SSE 通道模拟流式回复？—— 复刻环境走 API 发消息会唤醒复刻大獭（它无 LLM 配额会失败）。
  // 更可控：直接 DOM 注入模拟「新消息到达」事件流太假。
  // 真实路径：POST /messages 触发 SSE → 前端 append。发一条纯文本（无卡），观察贴底链。
  const input = page.locator('textarea').first()
  await input.fill('三轮取证：流式观察 R1')
  await input.press('Enter')
  await page.waitForTimeout(4000)

  const events = await page.evaluate(() => window.__triProbe.dump())
  console.log(`[tri-R1] 事件数: ${events.length}`)
  for (const e of events.slice(0, 30)) console.log(JSON.stringify(e))
  const byLayer = {}
  for (const e of events) byLayer[e.k] = (byLayer[e.k] || 0) + 1
  console.log(`[tri-R1] 分层: ${JSON.stringify(byLayer)}`)

  // R2：发一张 play 卡（agent 常发形态——本次取证的关键差异变量）
  await page.evaluate(() => window.__triProbe.clear())
  const ts = Date.now()
  await input.fill('```html-card-play title="tri-probe-' + ts + '"\n<div style="height:800px;background:linear-gradient(#fec,#fed)">R2 流式高卡 ' + ts + '</div>\n```')
  await input.press('Enter')
  await page.waitForTimeout(6000) // 覆盖乐观渲染 + 展开动画 + 高度桥回写

  const events2 = await page.evaluate(() => window.__triProbe.dump())
  console.log(`[tri-R2] 事件数: ${events2.length}`)
  for (const e of events2.slice(0, 40)) console.log(JSON.stringify(e))
  const byLayer2 = {}
  for (const e of events2) byLayer2[e.k] = (byLayer2[e.k] || 0) + 1
  console.log(`[tri-R2] 分层: ${JSON.stringify(byLayer2)}`)

  // 观察型断言（不强求 0——先取证后定罪，此用例输出即证据）
  expect(true).toBe(true)
})
