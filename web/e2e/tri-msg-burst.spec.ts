/**
 * F20261010 msg 层 9000px 暴冲取证：上轮 t=60s 处 msg 从 6142→15230 十连跳。
 * 疑点：注入发生在 t=20s，msg 层却在 t=60s 才暴动——正好是测试收尾时刻。
 * 本轮拆解：注入后每 5s 采样 msg 层状态（scrollTop/scrollHeight/距底），定位暴动触发者。
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'

const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'
const DB = process.env.HOME + '/.otter/alpha/51259f75/otter-buddy.db'

test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据')

test('msg 层暴动时序拆解', async ({ page }) => {
  await page.addInitScript({ path: './e2e/tri-scroll-probe.js' })
  await page.goto(`/conversation/${CONV}`)
  await page.waitForTimeout(3000)

  // 记录初始状态（贴底态：探针页本身在底部）
  const snap0 = await page.evaluate(() => {
    const msg = document.querySelector('[data-message-id]')
    let sc = msg
    while (sc) {
      const s = getComputedStyle(sc)
      if (/(auto|scroll)/.test(s.overflowY) && sc.scrollHeight > sc.clientHeight + 4) break
      sc = sc.parentElement
    }
    return sc ? { top: Math.round(sc.scrollTop), sh: sc.scrollHeight, ch: sc.clientHeight, distFromBottom: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) } : null
  })
  console.log(`[tri-M0] 初始: ${JSON.stringify(snap0)}`)

  // 注入后台 entry（非活跃会话）+ 同时往活跃会话注入一条（看 SSE/轮询是否拉活跃会话刷新）
  setTimeout(() => {
    try {
      execSync(`sqlite3 "${DB}" "INSERT INTO entries (id, conversation_id, entry_type, body, sender_id, created_at, sequence_num) SELECT lower(hex(randomblob(16))), '${CONV}', 'speak', '取证注入：活跃会话后台回复 ' || datetime('now'), 'otter-probe', datetime('now'), COALESCE(MAX(sequence_num),0)+1 FROM entries WHERE conversation_id='${CONV}'; UPDATE conversations SET updated_at=datetime('now') WHERE id='${CONV}';"`)
      console.log('[tri-M1] t=10s 已注入活跃会话 entry')
    } catch (e) { console.log('[tri-M1] 注入失败: ' + e) }
  }, 10000)

  await page.evaluate(() => window.__triProbe.clear())

  // 每 5s 采样，60s，共 12 个采样点（t 由外层传入——evaluate 闭包捕不到循环变量）
  for (let i = 1; i <= 12; i++) {
    await page.waitForTimeout(5000)
    const ti = i * 5
    const s = await page.evaluate((tt) => {
      const msg = document.querySelector('[data-message-id]')
      let sc = msg
      while (sc) {
        const s = getComputedStyle(sc)
        if (/(auto|scroll)/.test(s.overflowY) && sc.scrollHeight > sc.clientHeight + 4) break
        sc = sc.parentElement
      }
      return sc ? { t: tt, top: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight), dist: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) } : null
    }, ti)
    const ev = await page.evaluate(() => window.__triProbe.dump())
    console.log(`[tri-M] ${JSON.stringify(s)} 累计事件=${ev.length}`)
    if (ev.length > 0 && i <= 12) {
      for (const e of ev.slice(-6)) console.log('    ' + JSON.stringify(e))
      await page.evaluate(() => window.__triProbe.clear())
    }
  }
  expect(true).toBe(true)
})
