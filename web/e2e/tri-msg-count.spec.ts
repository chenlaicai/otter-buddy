/**
 * F20261010 消息暴增取证：卡片 2→3、sh +8817px。数 DOM 消息数与内容来源。
 */
import { test } from '@playwright/test'
import { execSync } from 'node:child_process'

const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'
const DB = process.env.HOME + '/.otter/alpha/51259f75/otter-buddy.db'

test.skip(!process.env.E2E_REPLICA_DATA, 'need replica')

test('消息数时序：注入后 DOM 消息增长路径', async ({ page }) => {
  await page.goto(`/conversation/${CONV}`)
  await page.waitForTimeout(3000)

  const snap = () => page.evaluate(() => {
    const msgs = [...document.querySelectorAll('[data-message-id]')]
    const msg = msgs[0]
    let sc = msg
    while (sc) {
      const s = getComputedStyle(sc)
      if (/(auto|scroll)/.test(s.overflowY) && sc.scrollHeight > sc.clientHeight + 4) break
      sc = sc.parentElement
    }
    return {
      n: msgs.length,
      top: sc ? Math.round(sc.scrollTop) : -1,
      sh: sc ? Math.round(sc.scrollHeight) : -1,
      lastMsg: msgs.length ? (msgs[msgs.length - 1].textContent || '').slice(0, 50) : '',
    }
  })

  console.log('[n0] 3s: ' + JSON.stringify(await snap()))

  // t=10s 注入
  setTimeout(() => {
    execSync(`sqlite3 "${DB}" "INSERT INTO entries (id, conversation_id, entry_type, body, sender_id, created_at, sequence_num) SELECT lower(hex(randomblob(16))), '${CONV}', 'speak', '取证注入 B：数消息路径 ' || datetime('now'), 'otter-probe', datetime('now'), COALESCE(MAX(sequence_num),0)+1 FROM entries WHERE conversation_id='${CONV}'; UPDATE conversations SET updated_at=datetime('now') WHERE id='${CONV}';"`)
    console.log('[inj] t=10s 注入完成')
  }, 10000)

  // 每 5s 采样消息数
  for (let i = 1; i <= 12; i++) {
    await page.waitForTimeout(5000)
    console.log(`[n${i * 5}] ` + JSON.stringify(await snap()))
  }
})
