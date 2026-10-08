/**
 * F20261008f1fx 逐帧滚动护栏（H1 闪跳回归锚）。
 *
 * 背景：两轮人工验证都判「通过」但线上仍跳——肉眼对 1 帧闪跳不敏感。本 spec 在真实
 * 浏览器逐帧采样 scrollTop，覆盖两大类高度变化源：
 *   A. React commit 驱动（新消息/流式增量）——useLayoutEffect 零间隙修复面
 *   B. CSS transition 驱动（卡片 iframe 200ms 高度动画，不走 React commit）——RO 链兜底面
 * 断言：贴底（pinned）状态下，任何采样帧的「距底距离」不得超过阈值——闪跳帧无所遁形。
 *
 * ⚠️ 环境前提：需要带「复刻会话数据」的服务实例（E2E_REPLICA_DATA=1 + E2E_BASE_URL
 * 指向含数据实例）——本 spec 全场景依赖真实消息组件（[data-message-id]）定位
 * scroller/找卡片。无数据环境（CI 空库）会空转恒绿（假防护），故显式门控拒绝运行：
 * 宁可 CI 报 skip，不要假绿。
 *
 * scroller 定位纪律（v4-v6 取证教训 + 检视獭严重发现 1）：`.overflow-y-auto` 裸选择器
 * 在页面有多个匹配（页面壳/左栏/消息容器），取首匹配=页面壳，注入与采样全在聊天区
 * 之外、断言恒绿零证明力。统一用 __findScroller（[data-message-id] 向上找祖先）。
 *
 * 判据阈值：距底 > 视口高度的 40% 且 >150px 即视为「可见跳变帧」（滚动条中段特征）。
 * 瞬时中间值不算——浏览器布局管线内的瞬时值采样器本身可能读到，只有肉眼可见时长
 * 的偏移才构成 bug。
 */
import { test, expect } from '@playwright/test'

// 与 scroll-restore-guard.spec.ts 同一复刻会话（《reseach》，1032 条/23 卡）
const CONV = '325ef7b7-8e42-4edc-9abf-eae8f332a2c4'
const MSG_SEL = '[data-message-id]'

/** 采样器：每 rAF 帧记录真实消息 scroller 的距底距离；暴露 __findScroller 供各步骤复用 */
const SAMPLER = `
  window.__frames = []
  window.__samplerOn = false
  window.__findScroller = () => {
    const m = document.querySelector('[data-message-id]')
    let el = m
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('overflow-y-auto')) return el
      el = el.parentElement
    }
    return null
  }
  ;(() => {
    const loop = () => {
      if (window.__samplerOn) {
        const el = window.__findScroller()
        if (el) window.__frames.push(el.scrollHeight - el.scrollTop - el.clientHeight)
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })()
`

/** 距底阈值判定：> 视口 40% 且 >150px = 可见跳变帧 */
function isViolation(dist: number, viewport: number) {
  return dist > Math.max(viewport * 0.4, 150)
}

/** 进入复刻会话、等真实消息渲染、贴底（pinned 语义） */
async function gotoBottomPinned(page: import('@playwright/test').Page) {
  await page.goto(`/conversation/${CONV}`)
  await page.waitForSelector(MSG_SEL, { timeout: 30_000 })
  await page.evaluate(() => {
    const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
    el.scrollTop = el.scrollHeight
  })
  await page.waitForTimeout(500)
}

/** 读取采样帧并断言无可见跳变帧 */
async function assertNoJump(page: import('@playwright/test').Page, tag: string) {
  const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames)
  const viewport = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().clientHeight)
  const violation = frames.filter(d => isViolation(d, viewport))
  console.log(`[${tag}] frames=${frames.length} viewport=${viewport} maxDist=${frames.length ? Math.max(...frames) : 0} violations=${violation.length}`)
  expect(violation.length, `闪跳帧序列：${frames.slice(0, 60).join(',')}`).toBe(0)
}

/** 经输入框真实发送一条 html-card 消息，返回「展开渲染」按钮 locator */
async function sendCardMessage(page: import('@playwright/test').Page, cardBody: string) {
  const input = page.locator('textarea').first()
  await input.fill('```html-card\n' + cardBody + '\n```')
  await input.press('Enter')
  const btn = page.getByRole('button', { name: '展开渲染' }).last()
  await expect(btn).toBeVisible({ timeout: 15_000 })
  return btn
}

test.describe('F20261008f1fx 贴底零闪跳护栏', () => {
  // 环境门控：无复刻会话数据时显式 skip（诚实输出，不产假绿）——CI 空库环境恒 skip
  test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据（E2E_REPLICA_DATA=1 + E2E_BASE_URL 指向含数据实例）')

  test('A: pinned 下新消息注入（真实组件渲染）——任何帧距底不超过阈值', async ({ page }) => {
    await page.addInitScript(SAMPLER)
    await gotoBottomPinned(page)

    // 开采样 → 真实发送一条消息（走输入框 UI：React commit/流式/账本 全路径生效）
    await page.evaluate(() => { (window as unknown as { __samplerOn: boolean }).__samplerOn = true })
    const input = page.locator('textarea').first()
    await input.fill(`f1fx-A 护栏消息 ${Date.now()}`)
    await input.press('Enter')
    // 等用户消息真实渲染（React commit 驱动的高度变化已发生）
    await page.waitForTimeout(2000) // 覆盖乐观消息渲染 + 后端回执替换的后续 commit
    await page.evaluate(() => { (window as unknown as { __samplerOn: boolean }).__samplerOn = false })

    await assertNoJump(page, 'f1fx-A')
  })

  test('B: pinned 下卡片 iframe 高度突变（真实 HtmlCard 组件）——RO 兜底链不出现长时掉底', async ({ page }) => {
    await page.addInitScript(SAMPLER)
    await gotoBottomPinned(page)

    // ⚠️ 必须用「视口内可见卡」：对不可见卡 playwright click 会先 scrollIntoView（用户滚动语义），
    // 点下时用户已不在底部（floating）——高度变化后保持位置是设计行为，不是闪跳（probe7/9 帧级审判）。
    // 真 bug 场景是「贴底用户自己点视口内的卡」。直接经输入框发一张真卡——乐观消息渲染在底部，
    // 按钮必然可见（复刻会话实测：现成卡全在折叠历史里，视口内 0 张）。
    // 不走 DOM 直插——iframe 的 transition-[height] duration-200 由真实 HtmlCard
    // 组件（HtmlCard.tsx:137）产生，正是 RO 链的设计覆盖源。
    await sendCardMessage(page, '<title>f1fx-B 护栏卡</title><p>height transition probe</p>')
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent === '展开渲染') as HTMLElement[]
      btns[btns.length - 1].dataset.f1fxProbe = '1'
    })
    const expandBtn = page.locator('button[data-f1fx-probe="1"]')
    // 发卡后 scroller 被乐观消息撑高——归位到底部（等效用户贴底）再开采样

    // 贴底 + 开采样 → 点展开（按钮已在视口内，click 无 scrollIntoView 位移）：
    // iframe mount 撑高（React commit）+ 内容加载后高度 transition 200ms ≈ 12 帧（RO→rAF 链补偿窗口）
    await page.evaluate(() => {
      const el = (window as unknown as { __findScroller(): HTMLElement }).__findScroller()
      el.scrollTop = el.scrollHeight
      ;(window as unknown as { __samplerOn: boolean }).__samplerOn = true
    })
    await expandBtn.click()
    await page.waitForTimeout(2000)
    await page.evaluate(() => { (window as unknown as { __samplerOn: boolean }).__samplerOn = false })

    await assertNoJump(page, 'f1fx-B')
  })
})
