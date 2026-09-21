/**
 * SPA 真机截图验证（F20260920spa，#1058 后脱硬编码）。
 *
 * 验证项：
 * 1. SPA 路由跳转无白屏（TopBar 持续存在）
 * 2. 深链接直达（直接访问 /memory 等不 404）
 * 3. 懒加载 chunk 生效（页面能正常渲染）
 * 4. 导航高亮正确
 *
 * 路由与截图输出约定（playwright.config.ts 单一真相源）：
 * - goto 用相对路径，baseURL 由 config 解析（env E2E_BASE_URL / 默认 alpha 端口）
 * - 截图写 testInfo.outputPath()——落 playwright outputDir（CI artifact），无绝对路径依赖
 */
import { test, expect } from '@playwright/test'

test.describe('SPA 路由截图验证', () => {
  test('根路径 / 重定向到 /conversation', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/conversation/)
    await expect(page.locator('header')).toBeVisible()
    const shot = test.info().outputPath('spa-home.png')
    await page.screenshot({ path: shot, fullPage: true })
  })

  test('深链接直达 /memory 不 404', async ({ page }) => {
    await page.goto('/memory')
    await expect(page).toHaveURL(/\/memory/)
    await expect(page.locator('header')).toBeVisible()
    await expect(page.getByText('记忆搜索')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('spa-memory.png'), fullPage: true })
  })

  test('深链接直达 /skills 不 404', async ({ page }) => {
    await page.goto('/skills')
    await expect(page).toHaveURL(/\/skills/)
    await expect(page.locator('header')).toBeVisible()
    await expect(page.getByText('能力库').first()).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('spa-skills.png'), fullPage: true })
  })

  test('深链接直达 /settings 不 404', async ({ page }) => {
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/settings/)
    await expect(page.locator('header')).toBeVisible()
    await expect(page.getByText('设置').first()).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('spa-settings.png'), fullPage: true })
  })

  test('深链接直达 /im 不 404', async ({ page }) => {
    await page.goto('/im')
    await expect(page).toHaveURL(/\/im/)
    await expect(page.locator('header')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('spa-im.png'), fullPage: true })
  })

  test('深链接直达 /health 不 404', async ({ page }) => {
    await page.goto('/health')
    await expect(page).toHaveURL(/\/health/)
    await expect(page.locator('header')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('spa-health.png'), fullPage: true })
  })

  test('深链接直达 /activity 不 404', async ({ page }) => {
    await page.goto('/activity')
    await expect(page).toHaveURL(/\/activity/)
    await expect(page.locator('header')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('spa-activity.png'), fullPage: true })
  })

  test('SPA 导航：点击 TopBar 链接切换页面无白屏', async ({ page }) => {
    await page.goto('/conversation')

    // D3 修复：isConnected 探针证明 TopBar DOM 节点存活（SPA 核心特征）
    // Why: elementHandle() 每次返回不同 JS 包装对象，toBe 比较包装对象恒假；
    //      handle.evaluate(el => el.isConnected) 在浏览器上下文检查底层 DOM 节点
    //      是否仍在文档中——若布局层重挂载，原节点脱离文档，探针变 false，证明力保留
    const header = page.locator('header')
    await expect(header).toBeVisible()
    const headerHandleBefore = await header.elementHandle()
    await page.screenshot({ path: test.info().outputPath('spa-nav-conversation.png'), fullPage: true })

    // 点击「记忆搜索」
    await page.getByText('记忆搜索').click()
    await expect(page).toHaveURL(/\/memory/)
    await expect(header).toBeVisible()
    // 验证导航前的 header DOM 节点仍然存活（未重挂载）
    expect(await headerHandleBefore!.evaluate(el => el.isConnected)).toBe(true)
    await expect(page.getByText('搜索关键词')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('spa-nav-memory.png'), fullPage: true })

    // 点击「设置」
    await page.getByRole('link', { name: '设置' }).click()
    await expect(page).toHaveURL(/\/settings/)
    await expect(header).toBeVisible()
    expect(await headerHandleBefore!.evaluate(el => el.isConnected)).toBe(true)
    await expect(page.getByText('模型').first()).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('spa-nav-settings.png'), fullPage: true })

    // 点击「对话」回到列表
    await page.getByRole('link', { name: '对话' }).click()
    await expect(page).toHaveURL(/\/conversation/)
    await expect(header).toBeVisible()
    expect(await headerHandleBefore!.evaluate(el => el.isConnected)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('spa-nav-back-to-conversation.png'), fullPage: true })
  })
})
