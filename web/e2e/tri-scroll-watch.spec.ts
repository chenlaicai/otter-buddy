/**
 * F20261010 三轮取证：左栏+中栏+页面级三层 scrollTop 帧级监控。
 * 场景：复刻《reseach》会话（含 25 张 play 形态卡——#1377 默认展开），
 * 复现搭档 10/9 报告的「左侧栏也上跳」现场。
 * 方法：挂 tri-probe → 进会话 → 静置采样（无任何交互，纯观察自动跳变）→ dump 事件流。
 */
import { test, expect } from '@playwright/test'

const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'

test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据（E2E_REPLICA_DATA=1 + E2E_BASE_URL 指向含数据实例）')

test('三层滚动静置取证：无交互下谁在自动跳', async ({ page }) => {
  await page.addInitScript({ path: './e2e/tri-scroll-probe.js' })
  await page.goto(`/conversation/${CONV}`)
  // 等首屏渲染 + play 卡 iframe 陆续加载
  await page.waitForTimeout(3000)
  await page.evaluate(() => window.__triProbe.clear())

  // 静置 15s：无任何交互。此窗口内若有自动跳变（play 卡高度桥回写触发重排），事件流会记录
  await page.waitForTimeout(15000)
  const events = await page.evaluate(() => window.__triProbe.dump())
  console.log(`[tri] 15s 静置事件数: ${events.length}`)
  for (const e of events.slice(0, 40)) console.log(JSON.stringify(e))

  // 分层统计
  const byLayer = {}
  for (const e of events) byLayer[e.k] = (byLayer[e.k] || 0) + 1
  console.log(`[tri] 分层: ${JSON.stringify(byLayer)}`)

  // 有任何自动滚动事件即红旗（静置下不应有滚动）
  expect(events.length, `静置期间发生自动滚动：${JSON.stringify(events.slice(0, 10))}`).toBe(0)
})
