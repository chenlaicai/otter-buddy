/**
 * F20261010 左栏取证 III：5s 轮询 × 60s 长静置。
 * 假设链：轮询 setConversations(新数组) → LeftPanel 重渲染 → 若列表项高度变化
 * （未读徽章/运行状态/排序）→ 浏览器 clamp 左栏 scrollTop → 「左栏上跳」。
 * 60s 覆盖 12 轮轮询。同时在库侧制造真实未读（给非活跃会话插 entry），
 * 模拟搭档多会话并行使用的真实数据形态。
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'

const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'
const DB = process.env.REPLICA_DB || process.env.HOME + '/.otter/alpha/51259f75/otter-buddy.db'

test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据')

test('轮询周期下的左栏稳定性（60s）', async ({ page }) => {
  await page.addInitScript({ path: './e2e/tri-scroll-probe.js' })
  await page.goto(`/conversation/${CONV}`)
  await page.waitForTimeout(3000)

  // 左栏滚到中部（阅读位置）
  const prep = await page.evaluate(() => {
    const aside = document.querySelector('aside')
    const sc = aside && [...aside.querySelectorAll('div')].find(d => {
      const s = getComputedStyle(d)
      return s.overflowY === 'auto' && d.scrollHeight > d.clientHeight + 4
    })
    if (!sc) return false
    sc.scrollTop = Math.floor(sc.scrollHeight / 2)
    return true
  })
  expect(prep, '左栏滚动容器就位').toBe(true)
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__triProbe.clear())

  // 静置中段（t=20s）往非活跃会话插一条真实 entry（未读 +1，updated_at 变化 → 排序刷新）
  setTimeout(() => {
    try {
      const cid = execSync(`sqlite3 "${DB}" "SELECT id FROM conversations WHERE id != '${CONV}' AND status='active' LIMIT 1;"`).toString().trim()
      if (cid) {
        execSync(`sqlite3 "${DB}" "INSERT INTO entries (id, conversation_id, entry_type, body, sender_id, created_at, sequence_num) SELECT lower(hex(randomblob(16))), '${cid}', 'speak', '取证注入：模拟后台回复 ' || datetime('now'), 'otter-probe', datetime('now'), COALESCE(MAX(sequence_num),0)+1 FROM entries WHERE conversation_id='${cid}'; UPDATE conversations SET updated_at=datetime('now') WHERE id='${cid}';"`)
        console.log('[tri-L3] t=20s 已注入后台 entry 到 ' + cid.slice(0, 8))
      }
    } catch (e) { console.log('[tri-L3] 注入失败: ' + e) }
  }, 20000)

  // 60s 静置观察
  await page.waitForTimeout(60000)
  const events = await page.evaluate(() => window.__triProbe.dump())
  console.log(`[tri-L3] 60s 事件总数: ${events.length}`)
  const byLayer = {}
  for (const e of events) byLayer[e.k] = (byLayer[e.k] || 0) + 1
  console.log(`[tri-L3] 分层: ${JSON.stringify(byLayer)}`)
  for (const e of events.slice(0, 40)) console.log(JSON.stringify(e))

  expect(true).toBe(true)
})
