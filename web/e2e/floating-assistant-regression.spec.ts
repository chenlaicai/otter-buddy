/**
 * F20260928waf1：浮动獭交互 bug 回归 e2e（失败固化 → 修复验证）。
 *
 * 覆盖（troubleshooting 5a 失败固化——修复前必须红）：
 * 1. 点击面板内输入框、输入文字 → 面板不消失（P1：panelRef 未绑定导致点内=点外）
 * 2. 点击面板内消息区空白处 → 面板不消失
 * 2b. hover 獭无快捷气泡（P2：快捷问句砍除后交互简化验证）
 * 2c. 侧栏无「创建 web 助理对话」按钮（P3：全局唯一语义，删除按钮）
 * 2d. 现有「点外收起」正路径仍工作（点页面其它区域 → 收起）
 * 注：本用例只验证交互行为，不做发消息（需真 LLM 回复）。
 */
import { test, expect } from '@playwright/test'

async function expectOtter(page: import('@playwright/test').Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const otter = page.locator('[data-testid="floating-otter"]')
  await expect(otter).toBeVisible({ timeout: 10_000 })
  return otter
}

test.describe('浮动獭交互回归（F20260928waf1）', () => {
  test('P1：点击输入框输入文字，面板不消失', async ({ page }) => {
    await page.goto('/conversation')
    const otter = await expectOtter(page)
    await otter.locator('[data-testid="floating-otter-avatar"]').click()
    const panel = page.locator('[data-testid="assistant-panel"]')
    await expect(panel).toBeVisible()
    const input = panel.locator('[data-testid="assistant-panel-input"]')
    await expect(input).toBeEnabled({ timeout: 15_000 })

    // 【失败固化】点击 input + 打字 → 面板必须仍在（修复前：panelRef 恒 null → 点内判外 → 收起）
    await input.click()
    await input.fill('测试输入')
    await expect(panel).toBeVisible()
    expect(await input.inputValue()).toBe('测试输入')
  })

  test('P1：点击消息区空白处，面板不消失', async ({ page }) => {
    await page.goto('/conversation')
    const otter = await expectOtter(page)
    await otter.locator('[data-testid="floating-otter-avatar"]').click()
    const panel = page.locator('[data-testid="assistant-panel"]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-testid="assistant-panel-input"]')).toBeEnabled({ timeout: 15_000 })
    // 点击消息流区域（面板内非交互元素）
    await panel.locator('[data-testid="assistant-panel-messages"]').click()
    await expect(panel).toBeVisible()
  })

  test('P2：hover 獭不出现快捷气泡', async ({ page }) => {
    await page.goto('/conversation')
    const otter = await expectOtter(page)
    await otter.locator('[data-testid="floating-otter-avatar"]').hover()
    await page.waitForTimeout(300)
    await expect(page.locator('[data-testid="floating-otter-hover-card"]')).toHaveCount(0)
  })

  test('P3：侧栏无「创建 web 助理对话」按钮（mock 空列表——防用例间首唤开户污染共享库）', async ({ page }) => {
    await page.route('**/api/conversations', async route => {
      // 一条普通对话 + 零 web 助理对话（空态独占视图只左栏不渲染——必须有一条才见分组）
      // glob 不含 **，避免误匹配 /api/conversations/:id/entries 子路径（检视 S1）
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ id: 'mock-conv-1', title: '普通对话', status: 'active', pinned: false, createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z' }],
          total: 1,
        }),
      })
    })
    await page.goto('/conversation')
    await expectOtter(page) // settings 请求不被 mock——獭照常挂载
    await page.waitForTimeout(500) // 侧栏渲染空列表
    await expect(page.locator('[data-testid="leftpanel-group-web-assistant"]')).toBeVisible()
    await expect(page.locator('[data-testid="leftpanel-web-assistant-create"]')).toHaveCount(0)
  })

  test('S3：面板展开时点獭收起，再点獭重展开', async ({ page }) => {
    await page.goto('/conversation')
    const otter = await expectOtter(page)
    await otter.locator('[data-testid="floating-otter-avatar"]').click()
    const panel = page.locator('[data-testid="assistant-panel"]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-testid="assistant-panel-input"]')).toBeEnabled({ timeout: 15_000 })

    // 面板开着再点獭 → 收起（toggle 路径，非点外收起）
    await otter.locator('[data-testid="floating-otter-avatar"]').click()
    await expect(panel).toBeHidden()

    // 再点獭 → 重展开（toggle 竞态回归——Esc flaky #1181 同路径）
    await otter.locator('[data-testid="floating-otter-avatar"]').click()
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-testid="assistant-panel-input"]')).toBeEnabled({ timeout: 15_000 })
  })

  test('正路径保留：点外收起仍工作', async ({ page }) => {
    await page.goto('/conversation')
    const otter = await expectOtter(page)
    await otter.locator('[data-testid="floating-otter-avatar"]').click()
    const panel = page.locator('[data-testid="assistant-panel"]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-testid="assistant-panel-input"]')).toBeEnabled({ timeout: 15_000 })

    // 点页面其它区域（header 左上角，面板与獭之外） → 收起
    await page.locator('header').click({ position: { x: 10, y: 10 } })
    await expect(panel).toBeHidden()
  })
})
