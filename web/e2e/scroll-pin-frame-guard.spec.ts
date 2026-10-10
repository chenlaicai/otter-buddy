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

/** F20261010vwst 场景 C 专用：scrollTop 稳定性采样器——逐帧记录 scroller 的 scrollTop。
 *
 * 与 SAMPLER（距底距离）不同：本场景断言的是「内容不动」而非「贴底跟随」——
 * 视口高度变化（输入框撑高）时距底距离会合法地变小（视口 clientHeight 缩了），
 * 用距底距离断言会把合法变化误判为跳变，改直接盯 scrollTop。 */
const TOP_SAMPLER = `
  window.__tops = []
  window.__topSamplerOn = false
  ;(() => {
    const loop = () => {
      if (window.__topSamplerOn) {
        const el = window.__findScroller ? window.__findScroller() : null
        if (el) window.__tops.push(el.scrollTop)
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })()
`

/** 终态断言辅助：采样末尾 N 帧均 ≤ 阈值（检视发现 6——峰值合规但终态停底不回的回归，
 *  逐帧断言抓不到：实验 3 实锤 600px 卡无补偿时 finalDist=124 恰在阈值下停住） */
async function assertFinalPinned(page: import('@playwright/test').Page, tag: string) {
  const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames)
  const tail = frames.slice(-10)
  const finalDist = tail.length ? Math.max(...tail) : 0
  console.log(`[${tag}] finalDist(末10帧max)=${finalDist}`)
  // 终态容限：补链完成后的残余间隙（rAF 合帧/RO 精度级），不是阈值百分比——
  // RO 冷启动死亡场景（发现 5）终态停底 124px 就是这断言要抓的形态
  expect(finalDist, `${tag} 终态距底 ${finalDist}px 未归零`).toBeLessThanOrEqual(8)
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

/** 经输入框真实发送一条 html-card 消息，返回「展开渲染」按钮 locator（唯一锚定）。
 *  锚定纪律：不能靠位置（nth/last）——发卡会唤醒 alpha 大獭，其回复流持续追加条目，
 *  位置锚在轮询间隙会漂到别的卡上（实锤：B 的 .last() 曾指到大獭回复里的卡）。
 *  唯一不变量用围栏 meta title（html-card.ts:47 parseCardTitle 解析 info string 的
 *  title="..."，渲染在卡头 HtmlCard.tsx:102）——卡体内 <title> 标签只进 iframe srcdoc，
 *  卡头恒显「未命名卡片」，锚不上（同样实锤过） */
async function sendCardMessage(page: import('@playwright/test').Page, cardBody: string) {
  const ts = Date.now()
  ;(page as unknown as { _lastCardTs: number })._lastCardTs = ts // 断言阶段复用同一时间戳锚定
  const input = page.locator('textarea').first()
  const beforeCount = await page.locator(MSG_SEL).count()
  await input.fill(`\`\`\`html-card title="f1fx-probe-${ts}"\n${cardBody}\n\`\`\``)
  await input.press('Enter')
  // 乐观消息渲染后消息数 +1（不等文本——历史卡也含 f1fx-probe，靠 count 锚定发生）
  await expect(page.locator(MSG_SEL)).toHaveCount(beforeCount + 1, { timeout: 15_000 })
  // 卡头渲染 meta title 文本（HtmlCard.tsx:102），用它唯一定位本张卡
  const cardHeader = page.locator('[data-card-id]', { hasText: `f1fx-probe-${ts}` }).first()
  return cardHeader.getByRole('button', { name: '展开渲染' })
}

test.describe('F20261008f1fx 贴底零闪跳护栏', () => {
  // 环境门控：无复刻会话数据时显式 skip（诚实输出，不产假绿）——CI 空库环境恒 skip
  test.skip(!process.env.E2E_REPLICA_DATA, '需要复刻会话数据（E2E_REPLICA_DATA=1 + E2E_BASE_URL 指向含数据实例）')

  test('A: pinned 下新消息注入（真实组件渲染）——任何帧距底不超过阈值', async ({ page }) => {
    await page.addInitScript(SAMPLER)
    await gotoBottomPinned(page)

    // 开采样 → 真实发送一张 600px 高卡并展开（检视发现 6：普通文本 27~108px < 判据下限 150px，
    // 刺激量不足护栏恒绿——修不好也红不了；折叠态只渲染按钮 ~108px 也不够，必须点「展开渲染」
    // 让 iframe 内 600px div 真实渲染，单次增量 >阈值才能钉住补偿链）
    await page.evaluate(() => { (window as unknown as { __samplerOn: boolean }).__samplerOn = true })
    const expandBtn = await sendCardMessage(page, '<title>f1fx-A 高卡</title><div style="height:600px">A 护栏大卡刺激源</div>')
    await expandBtn.click()
    // 等用户消息真实渲染（React commit 驱动的高度变化已发生）
    await page.waitForTimeout(2000) // 覆盖乐观消息渲染 + 展开动画 transition + 后端回执替换的后续 commit
    await page.evaluate(() => { (window as unknown as { __samplerOn: boolean }).__samplerOn = false })

    await assertNoJump(page, 'f1fx-A')
    await assertFinalPinned(page, 'f1fx-A')
    // 刺激源验收（防「发卡失败/渲染异常 → 刺激不足又恒绿」）：卡所在消息高度必须超阈值。
    // 锚卡容器而非展开按钮——展开后按钮已改名「收起」，按钮 locator 失效（实锄）；
    // 时间戳从 helper 存到 page 对象上取回（A 用例断言阶段复用发卡时刻的同一锄）
    const cardTs = (page as unknown as { _lastCardTs: number })._lastCardTs
    const viewport = await page.evaluate(() => (window as unknown as { __findScroller(): HTMLElement }).__findScroller().clientHeight)
    const cardH = await page.locator('[data-card-id]', { hasText: `f1fx-probe-${cardTs}` }).first()
      .evaluate(el => el.closest('[data-message-id]')?.getBoundingClientRect().height ?? 0)
    console.log(`[f1fx-A] 刺激源高度=${cardH}px 阈值=${Math.max(viewport * 0.4, 150)}px`)
    expect(cardH).toBeGreaterThan(Math.max(viewport * 0.4, 150))
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
    const expandBtn = await sendCardMessage(page, '<title>f1fx-B 护栏卡</title><p>height transition probe</p>')
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
    // 终态断言（检视发现 6 实验三：RO 链死/无补偿时终态停底 124px 不回，逐帧阈值抓不到——
    // finalDist 归零断言是 RO 冷启动修复（发现 5）的天然验收）
    await assertFinalPinned(page, 'f1fx-B')
  })

  test('C (F20261010vwst): 贴底下输入框输入多行（视口被压缩）——scrollTop 帧级稳定，无程序性顶起', async ({ page }) => {
    // 场景源头：搭档 10-10 报告「输入多行时中间栏消息跳动」——旧 viewportObserver 把输入框
    // autoResize 撑高当成需要贴底拉回的信号，每敲一个换行程序性 scrollTop += 一行高（~23px）。
    // 断言对象是 scrollTop 本身（不是距底）：视口高度变化时距底距离合法地变小（clientHeight 缩了），
    // 用距底断言会误判；scrollTop 不动才是「内容稳定」的正确判据。
    // ⚠️ 依赖真实 autoResize：input.fill 不触发键盘事件链，必须逐个 press Shift+Enter。
    // ⚠️ 避开干扰源：不发送（Enter 发送会追加消息、内容高度变化引入 contentObserver 合法补偿）
    await page.addInitScript(SAMPLER) // 提供 __findScroller
    await page.addInitScript(TOP_SAMPLER)
    await gotoBottomPinned(page)

    const input = page.locator('textarea').first()
    await input.click()
    // 输入 10 行文本，每行一个 Shift+Enter 换行——旧 bug 下累计被顶起 ≈ 10 行高（>> 允差）
    await page.evaluate(() => { (window as unknown as { __topSamplerOn: boolean }).__topSamplerOn = true })
    for (let i = 0; i < 10; i++) {
      await input.pressSequentially(`行${i + 1}`, { delay: 20 })
      await input.press('Shift+Enter')
    }
    await page.waitForTimeout(800) // 覆盖 autoResize 重排 + 可能的 rAF 补偿窗口
    await page.evaluate(() => { (window as unknown as { __topSamplerOn: boolean }).__topSamplerOn = false })

    const tops = await page.evaluate(() => (window as unknown as { __tops: number[] }).__tops)
    const first = tops.length ? tops[0] : 0
    const maxDrift = tops.length ? Math.max(...tops.map(t => Math.abs(t - first))) : 0
    const inputH = await input.evaluate(el => el.getBoundingClientRect().height)
    console.log(`[vwst-C] frames=${tops.length} scrollTop首帧=${first} maxDrift=${maxDrift}px 输入框末态高=${inputH}px`)
    // 刺激源验收（防恒绿）：输入框必须真实长高了（10 行 × ~23px > 初始 1 行），
    // 否则测试没触发视口压缩，断言无证明力
    expect(inputH, '输入框应随多行输入撑高（autoResize 生效）').toBeGreaterThan(60)
    // 帧级稳定：任何帧 scrollTop 偏离首帧 ≤ 4px（亚像素舍入级；旧 bug 每行 ~23px，10 行累计 ~230px）
    expect(maxDrift, `scrollTop 帧漂移 ${maxDrift}px 超允许值（帧序列前 60：${tops.slice(0, 60).join(',')}）`).toBeLessThanOrEqual(4)
  })
})
