/**
 * F20260924wast：web 助理（浮动獭）e2e 验证。
 *
 * 验证项（方案「验证」节）：
 * 1. 全页面常驻（conversation/memory/settings 页均可见獭）
 * 2. 点击獭展开面板 + 首唤自动开户（T2b：无 web 助理对话时创建）
 * 3. 双 tab 并发首唤收敛（N3：只建一条）
 * 4. Esc 收起 / ⌘J 唤起
 *
 * 不在本 spec（需真 LLM 后端/时间操纵，CI 不稳定）：流式回复细节、跨 8h session
 * 重启断言（SG2 由后端单测 web-assistant-session-entry.test.ts 覆盖）。
 * baseURL 单一真相源：playwright.config.ts。
 */
import { test, expect } from '@playwright/test'

/** 等浮动獭出现（settings 拉取完成后挂载）+ 降动画（呼吸/轻跳动画使元素不稳定，playwright 点不了） */
async function expectOtter(page: import('@playwright/test').Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const otter = page.locator('[data-testid="floating-otter"]')
  await expect(otter).toBeVisible({ timeout: 10_000 })
  return otter
}

test.describe('浮动獭（F20260924wast）', () => {
  test('全页面常驻：conversation/memory/settings 页均可见獭', async ({ page }) => {
    for (const path of ['/conversation', '/memory', '/settings']) {
      await page.goto(path)
      await expectOtter(page)
    }
  })

  test('点击獭展开面板 + 首唤自动开户（T2b）', async ({ page }) => {
    await page.goto('/conversation')
    const otter = await expectOtter(page)
    await otter.locator('[data-testid="floating-otter-avatar"]').click()

    // 面板出现 + 开户完成（输入框可用 = conversationId 就绪）
    const panel = page.locator('[data-testid="assistant-panel"]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-testid="assistant-panel-input"]')).toBeEnabled({ timeout: 15_000 })

    // 关闭面板后獭仍在
    await panel.locator('[data-testid="assistant-panel-close"]').click()
    await expect(panel).toBeHidden()
    await expect(page.locator('[data-testid="floating-otter"]')).toBeVisible()
  })

  test('Esc 收起 / ⌘J 唤起', async ({ page }) => {
    await page.goto('/conversation')
    const otter = await expectOtter(page)

    // ⌘J 展开（macOS ⌘；Linux/Win CI Ctrl）
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+j' : 'Control+j')
    await expect(page.locator('[data-testid="assistant-panel"]')).toBeVisible()

    // Esc 收起
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="assistant-panel"]')).toBeHidden()

    // 獭点击兜底再展开
    await otter.locator('[data-testid="floating-otter-avatar"]').click()
    await expect(page.locator('[data-testid="assistant-panel"]')).toBeVisible()
  })

  test('双 tab 并发首唤收敛（N3）：只建一条 web 助理对话', async ({ context, page }) => {
    await page.goto('/conversation')
    await expectOtter(page)

    // 两个 tab 同步首唤（并发窗口内各自 POST /api/conversations {kind}）
    const page2 = await context.newPage()
    await page2.goto('/conversation')
    await expectOtter(page2)

    await Promise.all([
      page.locator('[data-testid="floating-otter-avatar"]').click(),
      page2.locator('[data-testid="floating-otter-avatar"]').click(),
    ])
    await expect(page.locator('[data-testid="assistant-panel-input"]')).toBeEnabled({ timeout: 15_000 })
    await expect(page2.locator('[data-testid="assistant-panel-input"]')).toBeEnabled({ timeout: 15_000 })

    // 断言全局唯一：侧栏 web 助理分组只有一条（经 API 直查——绕开 DOM 折叠态）
    const res = await page.request.get('/api/conversations?kind=web-assistant&limit=10')
    expect(res.ok()).toBeTruthy()
    const { items } = await res.json() as { items: Array<{ id: string }> }
    expect(items.length).toBeLessThanOrEqual(1)
    await page2.close()
  })

  test('三态 data-mood 存在（冒泡/张望/睡觉任一）', async ({ page }) => {
    await page.goto('/conversation')
    const otter = await expectOtter(page)
    await expect(otter).toHaveAttribute('data-mood', /^(sleep|look|bubble)$/)
  })
})
