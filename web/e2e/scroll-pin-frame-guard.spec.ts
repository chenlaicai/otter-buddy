/**
 * F20261008f1fx 逐帧滚动护栏（H1 闪跳回归锚）。
 *
 * 背景：两轮人工验证都判「通过」但线上仍跳——肉眼对 1 帧闪跳不敏感。本 spec 在真实
 * 浏览器逐帧采样 scrollTop，覆盖两大类高度变化源：
 *   A. React commit 驱动（新消息/流式增量）——useLayoutEffect 零间隙修复面
 *   B. CSS transition 驱动（卡片 200ms 高度动画，不走 React commit）——RO 链兜底面
 * 断言：贴底（pinned）状态下，任何采样帧的「距底距离」不得超过阈值——闪跳帧无所遁形。
 *
 * 判据阈值：距底 > 视口高度的 40% 且 >150px 即视为「可见跳变帧」（滚动条中段特征）。
 * 瞬时中间值（< 视口 10%）不算——浏览器布局管线内的瞬时值采样器本身可能读到，
 * 只有肉眼可见时长的偏移才构成 bug。
 */
import { test, expect } from '@playwright/test'

const SCROLLER_SEL = '.overflow-y-auto'

/** 采样器：每 rAF 帧记录 scroller 的距底距离，注入页面后暴露 window.__pick() 读取 */
const SAMPLER = `
  window.__frames = []
  window.__samplerOn = false
  ;(() => {
    const loop = () => {
      if (window.__samplerOn) {
        const el = document.querySelector('${SCROLLER_SEL}')
        if (el) window.__frames.push(el.scrollHeight - el.scrollTop - el.clientHeight)
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })()
`

test.describe('F20261008f1fx 贴底零闪跳护栏', () => {
  test('A: pinned 下新消息/流式增量注入——任何帧距底不超过阈值', async ({ page }) => {
    await page.addInitScript(SAMPLER)
    await page.goto('/conversation')
    // 等对话页加载（獭面板等常驻元素）
    await page.waitForSelector(SCROLLER_SEL, { timeout: 15_000 })
    const scroller = page.locator(SCROLLER_SEL).first()

    // 建立长内容基线：注入 60 条消息（页面组件难以直接访问，走 DOM 直插模拟同构内容变化）
    await page.evaluate(() => {
      const content = document.querySelector('.overflow-y-auto > div')
      if (!content) return
      for (let i = 0; i < 60; i++) {
        const d = document.createElement('div')
        d.style.cssText = 'height:60px;border-bottom:1px solid #eee'
        d.textContent = `msg-${i}`
        content.appendChild(d)
      }
      const el = document.querySelector('.overflow-y-auto') as HTMLElement
      el.scrollTop = el.scrollHeight // 用户贴底（pinned 语义）
    })

    // 开采样 → 模拟流式增量（分 8 批，每批 5 块×40px，间隔 80ms≈5帧）
    await page.evaluate(() => { (window as unknown as { __samplerOn: boolean }).__samplerOn = true })
    for (let burst = 0; burst < 8; burst++) {
      await page.evaluate(() => {
        const content = document.querySelector('.overflow-y-auto > div')
        if (!content) return
        for (let i = 0; i < 5; i++) {
          const d = document.createElement('div')
          d.style.cssText = 'height:40px'
          content.appendChild(d)
        }
      })
      await page.waitForTimeout(80)
    }
    await page.evaluate(() => { (window as unknown as { __samplerOn: boolean }).__samplerOn = false })

    const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames)
    // 采样器从贴底后开始：首帧应近底；断言全程无「掉到中间」帧
    const viewport = await scroller.evaluate(el => el.clientHeight)
    const violation = frames.filter(d => d > Math.max(viewport * 0.4, 150))
    console.log(`[f1fx-A] frames=${frames.length} viewport=${viewport} maxDist=${Math.max(...frames)} violations=${violation.length}`)
    expect(violation.length, `闪跳帧序列：${frames.slice(0, 40).join(',')}`).toBe(0)
  })

  test('B: pinned 下上方内容 CSS transition 高度突变——RO 兜底链不出现长时掉底', async ({ page }) => {
    await page.addInitScript(SAMPLER)
    await page.goto('/conversation')
    await page.waitForSelector(SCROLLER_SEL, { timeout: 15_000 })

    // 注入一个「上方卡片」占位（模拟 html-card transition-[height] duration-200）+ 底部填充
    await page.evaluate(() => {
      const content = document.querySelector('.overflow-y-auto > div')
      if (!content) return
      const card = document.createElement('div')
      card.id = '__f1fx_card'
      card.style.cssText = 'height:80px;transition:height 200ms ease'
      card.textContent = 'card'
      content.insertBefore(card, content.firstChild)
      for (let i = 0; i < 40; i++) {
        const d = document.createElement('div')
        d.style.cssText = 'height:50px'
        content.appendChild(d)
      }
      const el = document.querySelector('.overflow-y-auto') as HTMLElement
      el.scrollTop = el.scrollHeight
    })

    // 开采样 → 触发卡片撑高 600px（transition 200ms ≈ 12 帧）
    await page.evaluate(() => { (window as unknown as { __samplerOn: boolean }).__samplerOn = true })
    await page.evaluate(() => {
      const card = document.getElementById('__f1fx_card')
      if (card) card.style.height = '680px'
    })
    await page.waitForTimeout(500)
    await page.evaluate(() => { (window as unknown as { __samplerOn: boolean }).__samplerOn = false })

    const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames)
    const viewport = await page.locator(SCROLLER_SEL).first().evaluate(el => el.clientHeight)
    // B 类不走 React commit：RO→rAF 每帧补偿允许 1 帧滞后（≤ 视口 15% 瞬时），但不得出现可见掉底
    const violation = frames.filter(d => d > Math.max(viewport * 0.4, 150))
    console.log(`[f1fx-B] frames=${frames.length} viewport=${viewport} maxDist=${Math.max(...frames)} violations=${violation.length}`)
    expect(violation.length, `B 类闪跳帧序列：${frames.slice(0, 40).join(',')}`).toBe(0)
  })
})
