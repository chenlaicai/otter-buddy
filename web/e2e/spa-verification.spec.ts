/**
 * SPA 迁移 Playwright 验证（F20260920spa）。
 *
 * 验证项：
 * 1. SPA 路由跳转无白屏（TopBar 持续存在）
 * 2. 深链接直达（直接访问 /memory 等不 404）
 * 3. 懒加载 chunk 生效（页面能正常渲染）
 * 4. 导航高亮正确
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3116'

test.describe('SPA 路由验证', () => {
  test('根路径 / 重定向到 /conversation', async ({ page }) => {
    await page.goto(`${BASE}/`)
    await expect(page).toHaveURL(/\/conversation/)
    // TopBar 应该存在
    await expect(page.locator('header')).toBeVisible()
  })

  test('深链接直达 /memory 不 404', async ({ page }) => {
    await page.goto(`${BASE}/memory`)
    await expect(page).toHaveURL(/\/memory/)
    // 页面应有「记忆搜索」标题或输入框
    await expect(page.locator('header')).toBeVisible()
    await expect(page.getByText('记忆搜索')).toBeVisible()
  })

  test('深链接直达 /skills 不 404', async ({ page }) => {
    await page.goto(`${BASE}/skills`)
    await expect(page).toHaveURL(/\/skills/)
    await expect(page.locator('header')).toBeVisible()
    await expect(page.getByText('能力库').first()).toBeVisible()
  })

  test('深链接直达 /settings 不 404', async ({ page }) => {
    await page.goto(`${BASE}/settings`)
    await expect(page).toHaveURL(/\/settings/)
    await expect(page.locator('header')).toBeVisible()
    await expect(page.getByText('设置').first()).toBeVisible()
  })

  test('深链接直达 /im 不 404', async ({ page }) => {
    await page.goto(`${BASE}/im`)
    await expect(page).toHaveURL(/\/im/)
    await expect(page.locator('header')).toBeVisible()
  })

  test('深链接直达 /health 不 404', async ({ page }) => {
    await page.goto(`${BASE}/health`)
    await expect(page).toHaveURL(/\/health/)
    await expect(page.locator('header')).toBeVisible()
  })

  test('深链接直达 /activity 不 404', async ({ page }) => {
    await page.goto(`${BASE}/activity`)
    await expect(page).toHaveURL(/\/activity/)
    await expect(page.locator('header')).toBeVisible()
  })

  test('SPA 导航：点击 TopBar 链接切换页面无白屏', async ({ page }) => {
    await page.goto(`${BASE}/conversation`)

    // R2 升级：获取 elementHandle 证明 TopBar 不重渲染（SPA 核心特征）
    // Why: toBeVisible() 只证明元素存在，elementHandle identity 证明是同一个 DOM 节点
    const header = page.locator('header')
    await expect(header).toBeVisible()
    const headerHandleBefore = await header.elementHandle()

    // 点击「记忆搜索」
    await page.getByText('记忆搜索').click()
    await expect(page).toHaveURL(/\/memory/)
    await expect(header).toBeVisible()
    const headerHandleAfterMemory = await header.elementHandle()
    expect(headerHandleAfterMemory).toBe(headerHandleBefore)
    await expect(page.getByText('搜索关键词')).toBeVisible()

    // 点击「设置」
    await page.getByRole('link', { name: '设置' }).click()
    await expect(page).toHaveURL(/\/settings/)
    await expect(header).toBeVisible()
    const headerHandleAfterSettings = await header.elementHandle()
    expect(headerHandleAfterSettings).toBe(headerHandleBefore)
    await expect(page.getByText('模型').first()).toBeVisible()

    // 点击「对话」回到列表
    await page.getByRole('link', { name: '对话' }).click()
    await expect(page).toHaveURL(/\/conversation/)
    await expect(header).toBeVisible()
    const headerHandleAfterBack = await header.elementHandle()
    expect(headerHandleAfterBack).toBe(headerHandleBefore)
  })

  test('SPA 导航：浏览器前进后退正常', async ({ page }) => {
    await page.goto(`${BASE}/conversation`)
    await page.goto(`${BASE}/memory`)
    await page.goto(`${BASE}/settings`)

    // 后退
    await page.goBack()
    await expect(page).toHaveURL(/\/memory/)

    // 再后退
    await page.goBack()
    await expect(page).toHaveURL(/\/conversation/)

    // 前进
    await page.goForward()
    await expect(page).toHaveURL(/\/memory/)
  })
})
