/**
 * F20260929wap1 失败固化（临时）：面板历史消息顺序 + invoke_start 渲染。
 * 修复前预期红：双重 reverse 使顺序颠倒；invoke_start 被过滤不渲染。
 */
import { test, expect } from '@playwright/test'

const CONV = 'e2e-panel-order'
const NOW = '2026-09-29T00:00:00Z'

test.describe('面板历史顺序 + 行动边界（F20260929wap1）', () => {
  test('历史加载按时间正序 + invoke_start 渲染为状态条', async ({ page }) => {
    // mock entries：seq 1 user hi → seq 2 invoke_start → seq 3 system 429 → seq 4 speak（若曾成功）
    await page.route(/\/api\/conversations\/[^/]+\/entries(\?.*)?$/, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            { id: 'e1', conversationId: CONV, sequenceNum: 1, entryType: 'user', body: 'hi', senderId: 'user', createdAt: NOW, status: 'completed' },
            { id: 'e2', conversationId: CONV, sequenceNum: 2, entryType: 'invoke_start', body: '🦦 大獭开始行动～', senderId: 'system', createdAt: NOW, status: 'completed' },
            { id: 'e3', conversationId: CONV, sequenceNum: 3, entryType: 'system', body: '[系统告警] 模型配额耗尽', senderId: 'system', createdAt: NOW, status: 'completed' },
            { id: 'e4', conversationId: CONV, sequenceNum: 4, entryType: 'speak', body: '你好呀', senderId: 'otter', createdAt: NOW, status: 'completed' },
          ],
          hasMore: false,
        }),
      })
    })
    await page.route(/\/api\/conversations(\?.*)?$/, async route => {
      const method = route.request().method()
      if (method === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: CONV, title: 'web 助理', kind: 'web-assistant', status: 'active', createdAt: NOW }),
        })
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [], total: 0 }),
        })
      }
    })
    await page.goto('/conversation')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const otter = page.locator('[data-testid="floating-otter"]')
    await expect(otter).toBeVisible({ timeout: 10_000 })
    await otter.locator('[data-testid="floating-otter-avatar"]').click()
    const panel = page.locator('[data-testid="assistant-panel"]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-testid="assistant-panel-input"]')).toBeEnabled({ timeout: 15_000 })
    // 面板历史加载走 entries API（无 conversationId 时不出请求）——等待消息渲染
    const msgs = panel.locator('[data-testid="assistant-panel-messages"]')
    await expect(panel.locator('[data-testid="assistant-panel-user-msg"]')).toBeVisible({ timeout: 10_000 })

    // 【红1】顺序断言：user 消息必须在 invoke 边界/system 告警之前（DOM 顺序）
    const order: string[] = await msgs.locator('[data-testid="assistant-panel-user-msg"], [data-testid="assistant-panel-otter-msg"], [data-testid="assistant-panel-system-msg"]').evaluateAll(
      els => els.map(el => el.getAttribute('data-testid') || ''),
    )
    // user(1) → invoke/trace(2) → system(3) → speak(4)：user 必须第一个，speak 必须最后一个
    expect(order[0]).toBe('assistant-panel-user-msg')
    expect(order[order.length - 1]).toBe('assistant-panel-otter-msg')
    // invoke_start 必须渲染（红2：修复前被 filter 掉）——type 收窄映射后带 system 样式
    expect(order).toContain('assistant-panel-system-msg')
  })
})
