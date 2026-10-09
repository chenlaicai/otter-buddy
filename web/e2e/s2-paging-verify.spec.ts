/**
 * S2 修复行为验证 v2：页面先加载（50 条窗口），后注入 250 条 gap，再触发 refresh。
 * 修复前（ASC LIMIT 截最新端）：refresh 后尾部停在 seq+200，最新 50 条不可达。
 * 修复后（循环翻页）：拉全 250 条，尾条 = 注入的第 250 号。
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'

const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'
const DB = process.env.HOME + '/.otter/alpha/51259f75/otter-buddy.db'

test.skip(!process.env.E2E_REPLICA_DATA, 'need replica')

test('S2 v2：加载后注入 250 条 gap，refresh 循环翻页拉全', async ({ page }) => {
  await page.goto(`/conversation/${CONV}`)
  await page.waitForTimeout(3000)

  const before = await page.evaluate(() => document.querySelectorAll('[data-message-id]').length)
  const lastBefore = await page.evaluate(() => {
    const ms = [...document.querySelectorAll('[data-message-id]')]
    return ms.length ? (ms[ms.length - 1].textContent || '').slice(-30) : ''
  })
  console.log(`[S2] 刷新前 n=${before} last="${lastBefore}"`)
  expect(before).toBe(50)

  // 页面加载后注入 220 条（>200 触发翻页；gap = 220）
  for (let i = 1; i <= 220; i++) {
    const sql = `INSERT INTO entries (id, conversation_id, entry_type, body, sender_id, created_at, sequence_num) SELECT lower(hex(randomblob(16))), '${CONV}', 'speak', 'S2v2 注入 ${i}/220', 'otter-probe', datetime('now'), COALESCE(MAX(sequence_num),0)+1 FROM entries WHERE conversation_id='${CONV}';`
    execSync(`sqlite3 "${DB}" ${JSON.stringify(sql)}`)
  }
  console.log('[S2] 220 条已注入（gap>200）')

  // 触发 refreshMessages（focus ack 路径——hasFocus 真实为 true）
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); Promise.resolve() })
  await page.waitForTimeout(400)
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
  await page.waitForTimeout(10000) // 300ms debounce + 220 条 ≈ 2 轮翻页

  const after = await page.evaluate(() => document.querySelectorAll('[data-message-id]').length)
  const lastAfter = await page.evaluate(() => {
    const ms = [...document.querySelectorAll('[data-message-id]')]
    return ms.length ? (ms[ms.length - 1].textContent || '').slice(-30) : ''
  })
  console.log(`[S2] 刷新后 n=${after} last="${lastAfter}"`)

  // 修复后断言：拉全——尾条是注入的最后一条（220/220），列表 50+220=270
  expect(after).toBe(270)
  expect(lastAfter).toContain('220/220')
})
