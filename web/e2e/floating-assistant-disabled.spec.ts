/**
 * F20260924wast：浮动獭开关关闭降级 e2e。
 * assistant.web.enabled=false（DI 启动注入）→ 獭不挂载，侧栏「web 助理」分组
 * 仍在（降级入口可见性）。
 * 用 route mock settings（避免依赖 e2e server 配置分支）。
 */
import { test, expect } from '@playwright/test'

test.describe('浮动獭开关关闭降级（F20260924wast）', () => {
  test('assistantWebEnabled=false：獭消失，侧栏 web 助理分组可见', async ({ page, request }) => {
    // 前置：建一条普通对话（LeftPanel 只在有对话的页面渲染——列表页空态独占是既有行为）
    const created = await request.post('/api/conversations', { data: { title: '降级测试' } })
    expect(created.ok()).toBeTruthy()
    const conv = await created.json() as { id: string }

    // mock GET /api/settings：开关关闭（AppLayout 按此不挂载浮动獭与全局轮询）
    await page.route('**/api/settings', async route => {
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, body: JSON.stringify({ ...body, assistantWebEnabled: false }) })
    })
    await page.goto(`/conversation/${conv.id}`)

    // TopBar 在（页面正常）
    await expect(page.locator('header')).toBeVisible()
    // 獭不出现（等待窗口跨过 settings 拉取）
    await page.waitForTimeout(1500)
    await expect(page.locator('[data-testid="floating-otter"]')).toHaveCount(0)
    // 侧栏 web 助理分组头可见（降级入口）
    await expect(page.locator('[data-testid="leftpanel-group-web-assistant"]')).toBeVisible()
  })
})
