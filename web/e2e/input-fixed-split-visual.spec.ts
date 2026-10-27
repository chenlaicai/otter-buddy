/**
 * F20261016inbs 真机视觉自查 + 布局断言（隔离 vite dev server，无后端依赖）。
 *
 * 不依赖后端 API：page.route 拦截全部 /api 请求并 mock 成「空对话列表」，直接
 * 渲染 ChatView。验证面：
 *   1. 默认边界：玻璃框固定高 120px，消息视口无写死 padding，衬垫 ≈ overlay 实高
 *   2. 拖分割条：高度变化 + clamp [64, 55%] + 松手 localStorage 持久化
 *   3. 重载恢复：持久化高度在新会话生效
 *   4. 输入内容不改变边界（多行 → 玻璃框高度不变，textarea 内部滚动）
 *   5. 死区归零：滚到底时最后一条消息紧贴输入框上沿（旧 bug 是悬空 98px 死区）
 *   6. 视觉截图（人审证据）
 *   7+8. F20261016pcov 卡片预览进覆盖层：发送/拒绝按钮真 hit-test 可点（旧 bug 被透明
 *        overlay 吞点击）+ 衬垫含卡片高
 *   9. F20261019ovmh 覆盖层总高封顶：短视口+大卡片 → overlay ≤ main 60% + 卡片内部滚动
 *        + 按钮恒可见 + 衬垫按封顶后实高（#1538）
 */
import { test, expect } from '@playwright/test'

/** mock /api：一条会话（消息走 entries）——SPA 正常渲染 ChatView + 输入覆盖层。
 *  匹配纪律：URL 解析后判 pathname 以 '/api/' 开头——裸正则 /\/api\// 会把
 *  '/src/api/client.ts' 模块也吞成 JSON → MIME 错误白屏（实测踩坑）；vite 的 `@fs`
 *  模块请求 pathname 不以 /api/ 开头，天然不命中。
 *  DTO 形状对齐 api-contract：ConversationListItemDTO / EntryDTO / ParticipantDTO /
 *  KeyInfoDTO / UnreadStateDTO / InvokeListResponseDTO / SettingsDTO */
async function mockApi(page: import('@playwright/test').Page, opts?: { cardBody?: string }) {
  await page.route(url => {
    try { return new URL(url).pathname.startsWith('/api/') } catch { return false }
  }, async route => {
    const url = route.request().url()
    let json: unknown = {}
    if (/\/api\/conversations(\/|$|\?)/.test(url) && !url.includes('/entries') && !url.includes('/participants') && !url.includes('/key-resources') && !url.includes('/unread') && !url.includes('/read') && !url.includes('/invokes') && !url.includes('/scheduled-tasks') && !url.includes('/resources') && !url.includes('/messages') && !url.includes('/subscribe')) {
      // listConversations → { items: ConversationListItemDTO[], total }
      const conv = {
        id: 'conv-inbs-probe',
        title: 'inbs 视觉自查',
        status: 'active',
        kind: 'normal',
        createdAt: '2026-10-16T00:00:00Z',
        updatedAt: '2026-10-16T00:00:00Z',
        completedAt: null,
        archivedAt: null,
        otterIds: ['otter-1'],
        unreadCount: 0,
        lastMessagePreview: null,
        lastMessageTs: null,
        activityStatus: 'idle',
      }
      json = url.match(/\/api\/conversations\/[^/?]+$/)
        ? conv // getConversation 单体
        : { items: [conv], total: 1 }
    } else if (url.includes('/entries')) {
      // listEntries → EntriesResponseDTO（EntryDTO[]——api-contract/api/entry.ts）
      const entries = Array.from({ length: 30 }, (_, i) => ({
        id: `msg-${i + 1}`,
        conversationId: 'conv-inbs-probe',
        sequenceNum: i + 1,
        entryType: 'message',
        senderType: i % 2 === 0 ? 'user' : 'otter',
        senderId: i % 2 === 0 ? 'user' : 'otter-1',
        body: i === 29 && opts?.cardBody ? opts.cardBody : `消息 ${i + 1}：视觉自查行 ${'█'.repeat(20 + (i % 5))}`,
        invokeId: null,
        yieldTargets: null,
        status: 'completed',
        source: 'web',
        metadata: null,
        senderName: i % 2 === 0 ? 'chen' : '自查獭',
        senderColor: null,
        contextTokens: null,
        contextTokensMax: null,
        createdAt: '2026-10-16T00:00:00Z',
        completedAt: '2026-10-16T00:00:00Z',
      }))
      json = { entries, hasMore: false }
    } else if (url.includes('/participants')) {
      // getParticipants → ParticipantDTO[]
      json = [{ id: 'p1', conversationId: 'conv-inbs-probe', otterId: 'otter-1', otterName: '自查獭', otterType: 'small', otterColor: 'teal', status: 'active', createdAt: '2026-10-16T00:00:00Z' }]
    } else if (url.includes('/key-resources')) {
      json = { resources: [] }
    } else if (url.includes('/unread')) {
      json = { lastReadSeq: 30, unreadCount: 0, firstUnreadMessageId: null, firstUnreadSeq: null }
    } else if (url.includes('/invokes')) {
      json = { invokes: [], hasMore: false }
    } else if (url.includes('/settings')) {
      json = { models: [], defaultModelAlias: '', userName: 'chen', port: 3000, dbPath: '', embeddingModelPath: '', embeddingDim: 0, assistantWebEnabled: false }
    } else if (url.includes('/otters/') && url.includes('/sessions')) {
      // getSessionHistory → OtterSessionDTO[]（裸数组，index.tsx 直接 dtos.map）
      json = []
    } else if (url.includes('/scheduled-tasks')) {
      // listScheduledTasks → ScheduledTaskDTO[]（裸数组，useScheduledTasks 直接 res.map）
      json = []
    } else if (url.includes('/read')) {
      json = { status: 'ok' }
    } else if (url.includes('/subscribe')) {
      // SSE 端点：无后端场景直接 204 空流（前端断连自愈，不阻塞渲染）
      await route.fulfill({ status: 204, body: '' })
      return
    }
    await route.fulfill({ json })
  })
}

const MSG_SEL = '[data-message-id]'
/** 打开会话页：等真实消息渲染 + 输入区就位 + RO 首帧稳定 */
async function openConversation(page: import('@playwright/test').Page, opts?: { cardBody?: string }) {
  await mockApi(page, opts)
  await page.goto('/conversation/conv-inbs-probe')
  await page.waitForSelector('textarea', { timeout: 15_000 })
  await page.waitForTimeout(800) // RO 首帧回调 + 衬垫渲染稳定
}

/** 测量布局 */
async function measure(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const glass = document.querySelector('.glass-input') as HTMLElement | null
    const textarea = document.querySelector('textarea') as HTMLElement | null
    const overlay = glass?.closest('.absolute.bottom-0') as HTMLElement | null
    const spacer = document.querySelector('[data-testid="bottom-spacer"]') as HTMLElement | null
    return {
      glassH: glass?.getBoundingClientRect().height ?? 0,
      textareaH: textarea?.getBoundingClientRect().height ?? 0,
      overlayH: overlay?.getBoundingClientRect().height ?? 0,
      spacerH: spacer?.getBoundingClientRect().height ?? 0,
      glassBoxH: (glass?.parentElement as HTMLElement | null)?.getBoundingClientRect().height ?? 0,
    }
  })
}

test.describe('F20261016inbs 输入框固定边界（vite 隔离实例）', () => {
  test('1+6: 默认边界 120px + 衬垫就位 + 截图', async ({ page }) => {
    await openConversation(page)
    const m = await measure(page)
    // 玻璃框（含 padding）固定高 120
    expect(m.glassBoxH).toBe(120)
    // 衬垫 ≈ overlay 实高（overlay = 分割条 8 - 上移 2 + 固定容器 120 + 外层 pt-2 pb-5）
    expect(m.spacerH).toBeGreaterThan(0)
    expect(Math.abs(m.spacerH - m.overlayH)).toBeLessThanOrEqual(2)
    await page.screenshot({ path: 'test-results/inbs-1-default.png', fullPage: false })
  })

  test('2: 拖分割条 → clamp + 持久化', async ({ page }) => {
    await openConversation(page)
    const splitter = page.locator('[role="separator"]')
    const box = await splitter.boundingBox()
    expect(box).toBeTruthy()
    // 上拖：从热区中心 (box.y + h/2) 到 box.y - 25 —— delta = h/2 + 25 = 29，
    // 120 → 149（注意：目标点若用 box.y-80，delta 含热区半高 4+80=84。用整刻度便于断言）
    const startY = box!.y + box!.height / 2
    await page.mouse.move(box!.x + box!.width / 2, startY)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2, startY - 80, { steps: 5 })
    await page.mouse.up()
    let m = await measure(page)
    expect(m.glassBoxH).toBe(200)
    const saved = await page.evaluate(() => localStorage.getItem('otter.chat.inputHeight'))
    expect(saved).toBe('200')

    // 下拖过头 → clamp 64（从当前位置再拖到屏下沿之外）
    const box2 = await splitter.boundingBox()
    const startY2 = box2!.y + box2!.height / 2
    await page.mouse.move(box2!.x + box2!.width / 2, startY2)
    await page.mouse.down()
    await page.mouse.move(box2!.x + box2!.width / 2, startY2 + 500, { steps: 5 })
    await page.mouse.up()
    m = await measure(page)
    expect(m.glassBoxH).toBe(64)
    await page.screenshot({ path: 'test-results/inbs-2-drag.png' })
  })

  test('3+4: 重载恢复 + 输入内容不改变边界', async ({ page }) => {
    await openConversation(page)
    // 先拖到 160：中心起上拖 40+4（delta 含热区半高，用整刻度断言）
    const splitter = page.locator('[role="separator"]')
    const box = await splitter.boundingBox()
    const startY = box!.y + box!.height / 2
    await page.mouse.move(box!.x + box!.width / 2, startY)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2, startY - 40, { steps: 5 })
    await page.mouse.up()
    expect((await measure(page)).glassBoxH).toBe(160)

    // 重载（同 origin，localStorage 同源持久）→ 恢复 160
    await page.reload()
    await page.waitForSelector('textarea', { timeout: 15_000 })
    await page.waitForTimeout(600)
    expect((await measure(page)).glassBoxH, '重载恢复持久化高度').toBe(160)

    // 输入 20 行 → 边界不动，textarea 内部滚动
    const before = await measure(page)
    await page.locator('textarea').fill(Array.from({ length: 20 }, (_, i) => `第${i + 1}行：固定边界自查长文本行内容`).join('\n'))
    await page.waitForTimeout(300)
    const after = await measure(page)
    expect(after.glassBoxH, '输入内容不改变边界（拍板原话）').toBe(before.glassBoxH)
    expect(after.textareaH).toBe(before.textareaH)
    // textarea 内容超高 → 内部滚动
    const scrollable = await page.evaluate(() => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement
      return ta.scrollHeight > ta.clientHeight
    })
    expect(scrollable, 'textarea 内部滚动（两框各自滚动）').toBe(true)
    await page.screenshot({ path: 'test-results/inbs-3-fixed-with-multiline.png' })
  })

  test('5: 死区归零——滚到底时最后一条消息紧贴输入框上沿（无 98px 悬空）', async ({ page }) => {
    await openConversation(page)
    await page.waitForSelector(MSG_SEL, { timeout: 15_000 })
    // 滚到底（程序写入语义）
    await page.evaluate(() => {
      const m = document.querySelector('[data-message-id]')
      let el = m as HTMLElement | null
      while (el && !el.classList.contains('overflow-y-auto')) el = el.parentElement
      el!.scrollTop = el!.scrollHeight
    })
    await page.waitForTimeout(300)
    const m = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-id]')
      const last = msgs[msgs.length - 1] as HTMLElement
      const glass = document.querySelector('.glass-input') as HTMLElement
      const overlay = glass.closest('.absolute.bottom-0') as HTMLElement
      const scroller = (() => { const el0 = document.querySelector('[data-message-id]'); let el = el0 as HTMLElement | null; while (el && !el.classList.contains('overflow-y-auto')) el = el.parentElement; return el! })()
      const main = scroller.closest('main') as HTMLElement
      const mcs = getComputedStyle(main)
      const mainInnerBottom = main.getBoundingClientRect().bottom - parseFloat(mcs.borderBottomWidth) - parseFloat(mcs.paddingBottom)
      return {
        gap: Math.round(glass.getBoundingClientRect().top - last.getBoundingClientRect().bottom),
        distToBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
        overlayBottom: Math.round(overlay.getBoundingClientRect().bottom),
        mainInnerBottom: Math.round(mainInnerBottom),
        overlayAnchoredToMain: Math.abs(overlay.getBoundingClientRect().bottom - mainInnerBottom) <= 1,
      }
    })
    // 结构断言（环境无关，R1 锚定后 dev/prod 一致）：overlay 底 == main 内盒底。
    // 旧 bug（检视獭发现，CI 实测 38px）：build 压缩丢标准 backdrop-filter → 覆盖层
    // 漂到外层 wrapper（探出 main 13px）；main 显式 relative 后两环境都锚 main 内盒
    expect(m.overlayAnchoredToMain, '覆盖层必须锚定 main 内盒底（dev/prod 一致，不依赖 backdrop-filter 副作用）').toBe(true)
    expect(m.distToBottom).toBe(0)
    // 语义断言：gap = 消息 mb-4(16px) + overlay 顶部 pt-2(8px) + 圆整 1 ≈ 25px（旧 bug 98px 死区）。
    // 阈值 ≤30px：任何超出意味着预留/实高错位又回来了
    expect(m.gap).toBeLessThanOrEqual(30)
    await page.screenshot({ path: 'test-results/inbs-5-no-deadzone.png' })
  })
})

/** F20261016pcov：卡片预览槽位进覆盖层（搭档 10-16 报告「交互卡片触发的回答点不了」）。
 *  根因：预览卡是 main 文档流子元素，输入覆盖层（absolute bottom-0 z-10）透明叠其上——
 *  hit-test 照吃，发送/拒绝按钮点击全被吞。修法：卡片挪进覆盖层内（分割条下方、
 *  输入框上方），衬垫自然含卡片高。真值验证必须真浏览器 hit-test（jsdom 无布局）。
 *  卡片触发链：mock 一条含 ```html-card importance="high"``` 的 otter 消息（默认展开）→
 *  iframe 挂载注册 registry → frame 内调 window.otterCard.submit()（source=iframe win，
 *  白名单自动通过）→ 预览槽位出现。 */
const CARD_BODY = [
  '```html-card title="答案确认卡" importance="high"',
  '<div><p>请确认你的答案</p></div>',
  '```',
].join('\n')

test.describe('F20261016pcov 卡片预览进覆盖层（vite 隔离实例）', () => {
  test('7: 发送按钮真 hit-test 可点（旧 bug：透明 overlay 吞点击）+ 衬垫含卡片', async ({ page }) => {
    const posts: string[] = []
    page.on('request', req => {
      if (req.method() === 'POST' && /\/api\/conversations\/[^/]+\/messages$/.test(new URL(req.url()).pathname)) {
        posts.push(req.postData() ?? '')
      }
    })
    await openConversation(page, { cardBody: CARD_BODY })

    // importance=high 默认展开 → iframe 挂载并注册 registry
    const card = page.locator('[data-card-id]')
    await expect(card).toBeVisible()
    const frame = page.frameLocator('[data-card-id] iframe')
    await frame.locator('body').waitFor({ timeout: 15_000 })

    // 卡片内提交（桥 API，source=iframe contentWindow 白名单自动通过）→ 预览槽位出现
    await frame.locator('body').evaluate(() =>
      (window as unknown as { otterCard: { submit: (p: unknown) => void } }).otterCard.submit({ summary: '确认发送以下答案', data: { answer: '是' } }),
    )
    const preview = page.locator('[data-testid="card-preview"]')
    // 预览出现断言用文本锚（testid 无关）——失败证据链需在旧 DOM 上复现「被吞」而非 testid 缺失
    await expect(page.getByText('以下内容由水獭卡片生成')).toBeVisible()

    // 命中测试：发送按钮中心点 elementFromPoint 必须命中按钮自身（旧 bug：overlay 吞掉 hit-test）。
    // 文本锚找按钮（不依赖 testid）：MessageInput 发送按钮无文本（仅图标），此处文本匹配唯一
    const hit = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const btn = btns.find(b => b.textContent === '发送') as HTMLElement | undefined
      if (!btn) return false
      const r = btn.getBoundingClientRect()
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return el === btn || btn.contains(el)
    })
    expect(hit, '发送按钮必须可命中（旧 bug：透明 overlay 吞点击）').toBe(true)

    // DOM 结构契约（testid）：预览卡必须在覆盖层内 + 衬垫含卡片高
    await expect(preview).toBeVisible()
    const inOverlay = await page.evaluate(() => {
      const card0 = document.querySelector('[data-testid="card-preview"]')
      const glass = document.querySelector('.glass-input')
      return !!card0 && !!glass && glass.closest('.absolute.bottom-0')!.contains(card0)
    })
    expect(inOverlay, '预览卡必须是输入覆盖层的子元素').toBe(true)

    // 衬垫含卡片：overlay 实高（分割条+预览卡+输入区）≈ 消息列表末尾衬垫
    const pad = await page.evaluate(() => {
      const glass = document.querySelector('.glass-input') as HTMLElement
      const overlay = glass.closest('.absolute.bottom-0') as HTMLElement
      const spacer = document.querySelector('[data-testid="bottom-spacer"]') as HTMLElement
      return { overlayH: overlay.getBoundingClientRect().height, spacerH: spacer.getBoundingClientRect().height }
    })
    expect(Math.abs(pad.spacerH - pad.overlayH), '衬垫应等于 overlay 实高（含预览卡）').toBeLessThanOrEqual(2)

    // 真点击 → 回执发出（html-card-reply 路由卡片作者）+ 预览消失
    await page.locator('button', { hasText: '发送' }).click({ timeout: 5_000 })
    await expect(preview).toBeHidden()
    expect(posts.some(p => p.includes('html-card-reply')), '回执 body 应含 html-card-reply 围栏').toBe(true)
    await page.screenshot({ path: 'test-results/pcov-1-confirm-clickable.png' })
  })

  test('8: 拒绝按钮可点（同层命中），拒绝后预览消失且不发回执', async ({ page }) => {
    const posts: string[] = []
    page.on('request', req => {
      if (req.method() === 'POST' && /\/api\/conversations\/[^/]+\/messages$/.test(new URL(req.url()).pathname)) {
        posts.push(req.postData() ?? '')
      }
    })
    await openConversation(page, { cardBody: CARD_BODY })
    const frame = page.frameLocator('[data-card-id] iframe')
    await frame.locator('body').waitFor({ timeout: 15_000 })
    await frame.locator('body').evaluate(() =>
      (window as unknown as { otterCard: { submit: (p: unknown) => void } }).otterCard.submit({ summary: '确认发送以下答案', data: { answer: '否' } }),
    )
    const preview = page.locator('[data-testid="card-preview"]')
    await expect(page.getByText('以下内容由水獭卡片生成')).toBeVisible()
    await page.locator('button', { hasText: '拒绝' }).click({ timeout: 5_000 })
    await expect(page.getByText('以下内容由水獭卡片生成')).toBeHidden()
    await expect(preview).toBeHidden()
    expect(posts.some(p => p.includes('html-card-reply')), '拒绝不应发回执').toBe(false)
    await page.screenshot({ path: 'test-results/pcov-2-reject-clickable.png' })
  })
})

test.describe('F20261027nmbf 新消息浮窗几何与点击命中（真实浏览器）', () => {
  /** 先上翻进入 floating，再释放真实 SSE 发言；验证完整计数、几何与点击链路 */
  async function openFloatingBadge(page: import('@playwright/test').Page) {
    await openConversation(page)
    let releaseSSE!: () => void
    const holdSSE = new Promise<void>(resolve => { releaseSSE = resolve })
    // 后注册优先：仅本用例的 subscribe 请求等待测试释放，其余 API 沿用上方 mock
    await page.route('**/api/conversations/*/subscribe', async route => {
      await holdSSE
      const badgeEntry = {
        entryId: 'msg-badge-31', otterId: 'otter-1', otterName: '自查獭', otterType: 'small',
        body: '滚动离开后收到的新消息', sequenceNum: 31, createdAt: '2026-10-27T08:00:00Z',
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: `event: entry.speak\ndata: ${JSON.stringify(badgeEntry)}\n\n`,
      })
    })
    const scroller = page.locator('main div.overflow-y-auto')
    await scroller.evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }))
    await scroller.evaluate(el => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })))
    await page.waitForTimeout(150)
    expect(await scroller.evaluate(el => el.scrollTop), 'SSE 放行前必须已上翻').toBe(0)
    releaseSSE()
    await expect(page.getByText('滚动离开后收到的新消息')).toBeVisible()
    const badge = page.getByRole('button', { name: /新消息 \d+ 条/ })
    await expect(badge).toBeVisible()
    await page.waitForTimeout(150)
    return { scroller, badge }
  }

  async function badgeGeometry(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
      const scroller = document.querySelector('main div.overflow-y-auto') as HTMLElement
      const badge = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('新消息')) as HTMLElement
      const overlay = document.querySelector('main .absolute.bottom-0') as HTMLElement
      const r = badge.getBoundingClientRect()
      const sr = scroller.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroller: { top: sr.top, bottom: sr.bottom, height: sr.height },
        badge: { top: r.top, bottom: r.bottom, height: r.height },
        overlayTop: overlay.getBoundingClientRect().top,
        hit: hit === badge || badge.contains(hit),
      }
    })
  }

  test('11a: 常规窗口浮窗在覆盖层上方且点击回底清零', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    const { badge } = await openFloatingBadge(page)
    const m = await badgeGeometry(page)
    expect(m.badge.bottom, `浮窗底 ${m.badge.bottom} 应高于覆盖层顶 ${m.overlayTop}`).toBeLessThanOrEqual(m.overlayTop - 15)
    expect(m.badge.top).toBeGreaterThanOrEqual(m.scroller.top)
    expect(m.hit, '中心命中浮窗自身而非覆盖层').toBe(true)
    await page.screenshot({ path: 'test-results/nmbf-11a-normal.png', fullPage: false })
    await badge.click()
    await expect(page.getByRole('button', { name: /新消息 \d+ 条/ })).toHaveCount(0)
  })

  test('11b: 矮窗口大输入覆盖层下浮窗仍完整可见、可点、不回显负 bottom', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 })
    await page.addInitScript(() => localStorage.setItem('otter.chat.inputHeight', '2000'))
    const { badge } = await openFloatingBadge(page)
    const m = await badgeGeometry(page)
    expect(m.badge.top, `钳位后顶 ${m.badge.top} 不得越过消息区顶 ${m.scroller.top}`).toBeGreaterThanOrEqual(m.scroller.top + 7)
    expect(m.badge.bottom).toBeLessThanOrEqual(m.scroller.bottom)
    expect(m.badge.bottom).toBeLessThanOrEqual(m.overlayTop - 7)
    expect(m.hit, '矮窗口中心命中浮窗自身').toBe(true)
    await page.screenshot({ path: 'test-results/nmbf-11b-short.png', fullPage: false })
    await badge.click()
    await expect(page.getByRole('button', { name: /新消息 \d+ 条/ })).toHaveCount(0)
  })
})

test.describe('F20261019ovmh-R2 卡片态输入让步（检视獭-1552 严重 1 处置）', () => {
  /** 拖分割条到指定意图高度（move startY-N = 高度 +N，clamp 生效后为实际值） */
  async function dragTo(page: import('@playwright/test').Page, targetH: number) {
    const splitter = page.locator('[role="separator"]')
    const box = await splitter.boundingBox()
    const startY = box!.y + box!.height / 2
    const cur = await page.evaluate(() => parseInt(document.querySelector('.glass-input')!.parentElement!.style.height!, 10))
    await page.mouse.move(box!.x + box!.width / 2, startY)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2, startY - (targetH - cur), { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(350) // RO 回调 + 布局稳定
  }

  async function measureR2(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
      const main = document.querySelector('main')!
      const overlay = document.querySelector('.absolute.bottom-0')!
      const card = document.querySelector('[data-testid="card-preview"]')!
      const inputBox = document.querySelector('.glass-input')!.parentElement!
      const sendBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '发送') as HTMLElement
      const sendR = sendBtn!.getBoundingClientRect()
      const mainR = main.getBoundingClientRect()
      const inMain = sendR.bottom <= mainR.bottom + 0.5 && sendR.top >= mainR.top
      const midX = Math.min(Math.max(sendR.x + sendR.width / 2, 1), window.innerWidth - 1)
      const hitEl = inMain ? document.elementFromPoint(midX, sendR.y + sendR.height / 2) : null
      const hit = !!hitEl && (hitEl === sendBtn || sendBtn.contains(hitEl))
      return {
        inputH: parseInt(inputBox.style.height, 10),
        overlayH: Math.round(overlay.getBoundingClientRect().height),
        mainH: Math.round(mainR.height),
        cap: Math.floor(main.getBoundingClientRect().height * 0.6),
        cardH: Math.round(card.getBoundingClientRect().height),
        sendVisible: inMain,
        sendHit: hit,
        inputBoxBottomInMain: inputBox.getBoundingClientRect().bottom <= mainR.bottom + 0.5,
      }
    })
  }

  async function openBigCard(page: import('@playwright/test').Page) {
    await openConversation(page, { cardBody: CARD_BODY })
    const frame = page.frameLocator('[data-card-id] iframe')
    await frame.locator('body').waitFor({ timeout: 15_000 })
    await frame.locator('body').evaluate(() => {
      const summary = '大卡片提交摘要：'.padEnd(240, '长') + '，以上数据请逐项核对后发送，确认无误再点发送按钮，避免误发不可撤回的回执。'
      const rows = Array.from({ length: 8 }, (_, i) => ({ id: i, name: 'field-item-'.concat(String(i)).padEnd(4), value: 'x'.repeat(150), note: '备注'.repeat(4) }))
      ;(window as unknown as { otterCard: { submit: (p: { summary: string; data: unknown }) => void } }).otterCard.submit({ summary, data: { form: '长表单核对', rows } })
    })
    await page.waitForSelector('[data-testid="card-preview"]', { timeout: 5_000 })
    await page.waitForTimeout(400)
  }

  test('10a: 矮屏(640x480)拖高档+大卡：输入让步收紧 133、卡片地板 68、按钮可点、输入不出界', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 480 })
    await openBigCard(page)
    // 拖到顶（意图远超上限）：收紧上限 = min(217, 237-36)=201 - 地板68 = 133
    await dragTo(page, 999)
    const m = await measureR2(page)
    // 输入被收紧（不再吃掉卡片预算）：640x480 实测 main=396, cap=237, limitRaw=201, 地板=68 → 133
    expect(m.inputH, `输入收紧到 133（实测 main=${m.mainH}）`).toBeLessThanOrEqual(135)
    expect(m.inputH).toBeGreaterThanOrEqual(64)
    // 卡片地板：按钮行所在的卡不塌没
    expect(m.cardH, '卡片 ≥ 地板 68').toBeGreaterThanOrEqual(66)
    // 发送按钮在 main 内且真命中（hit-test，#1535 核心承诺在拖高档保住）
    expect(m.sendVisible).toBe(true)
    expect(m.sendHit).toBe(true)
    // 输入盒（hint 行在内）不出 main 底（检视 P2 出界态修复）
    expect(m.inputBoxBottomInMain).toBe(true)
    // overlay 恰装满封顶（零和验证）：|overlay - cap| ≤ 2
    expect(Math.abs(m.overlayH - m.cap), `overlay=${m.overlayH} ≈ cap=${m.cap}`).toBeLessThanOrEqual(2)
    await page.screenshot({ path: 'test-results/ovmh-10a-maxed.png' })
    // 拖回 120：恢复正常（自愈路径，检视 P5 拖 160 态同被 clamp 覆盖于上）
    await dragTo(page, 120)
    const m2 = await measureR2(page)
    expect(m2.inputH).toBe(120)
    expect(m2.sendHit).toBe(true)
  })

  test('10b: 大屏(1280x900)拖顶+大卡：上限由 55% 绑定 → 收紧 380，按钮可点', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openBigCard(page)
    await dragTo(page, 999)
    const m = await measureR2(page)
    // 1280x900 实测 main≈816: cap=489, 55%=448 与 453 取小=448, budget=5, 地板68 → 380
    expect(m.inputH, `输入收紧到 ~380（实测 main=${m.mainH}）`).toBeLessThanOrEqual(382)
    expect(m.cardH).toBeGreaterThanOrEqual(66)
    expect(m.sendHit, '大屏拖顶按钮仍可点（检视 P4 态修复）').toBe(true)
    expect(m.inputBoxBottomInMain).toBe(true)
  })
})

test.describe('F20261019ovmh 覆盖层总高封顶（vite 隔离实例）', () => {
  test('9: 短视口+大卡片 → overlay 封顶 60% + 卡片内部滚动 + 按钮恒可见 + 衬垫按封顶实高', async ({ page }) => {
    // 短视口复现 #1538 案发条件：矮屏幕 + 预览卡数据区展开
    await page.setViewportSize({ width: 640, height: 480 })
    await openConversation(page, { cardBody: CARD_BODY })
    const frame = page.frameLocator('[data-card-id] iframe')
    await frame.locator('body').waitFor({ timeout: 15_000 })
    // 大 payload（限内：summary ≤500 字符 + data ≤2KB，validateCardSubmitPayload 上限——
    // 超限会被静默拒，卡片不出现）：summary 拉满 + dataJson 撑到 ~1.9KB，480px 视口下展开
    // 态自然高远超 60% 预算，足以触发封顶 + 内部滚动
    await frame.locator('body').evaluate(() => {
      const summary = '大卡片提交摘要：'.padEnd(240, '长') + '，以上数据请逐项核对后发送，确认无误再点发送按钮，避免误发不可撤回的回执。'
      const rows = Array.from({ length: 8 }, (_, i) => ({ id: i, name: 'field-item-'.concat(String(i)).padEnd(4), value: 'x'.repeat(150), note: '备注'.repeat(4) }))
      ;(window as unknown as { otterCard: { submit: (p: { summary: string; data: unknown }) => void } }).otterCard.submit({ summary, data: { form: '长表单核对', rows } })
    })
    await expect(page.getByText('以下内容由水獭卡片生成')).toBeVisible()
    await page.waitForTimeout(300) // RO 回调 + 封顶布局稳定

    const m = await page.evaluate(() => {
      const main = document.querySelector('main') as HTMLElement
      const overlay = document.querySelector('.absolute.bottom-0') as HTMLElement
      const card = document.querySelector('[data-testid="card-preview"]') as HTMLElement
      const scrollArea = card.querySelector('.overflow-y-auto') as HTMLElement
      const spacer = document.querySelector('[data-testid="bottom-spacer"]') as HTMLElement
      const btns = Array.from(document.querySelectorAll('button'))
      const sendBtn = btns.find(b => b.textContent === '发送') as HTMLElement | undefined
      const r = sendBtn!.getBoundingClientRect()
      const hit = sendBtn ? (() => { const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el === sendBtn || sendBtn.contains(el as Node) })() : false
      return {
        mainH: main.getBoundingClientRect().height,
        overlayH: overlay.getBoundingClientRect().height,
        spacerH: spacer.getBoundingClientRect().height,
        scrollClientH: scrollArea.clientHeight,
        scrollScrollH: scrollArea.scrollHeight,
        btnVisibleInViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0,
        btnHit: hit,
      }
    })
    // 封顶生效：overlay ≤ main 60%（+1px 取整容差）
    expect(m.overlayH, `overlay ${m.overlayH} 应封顶 ≤ main ${m.mainH} 的 60%`).toBeLessThanOrEqual(m.mainH * 0.6 + 1)
    // 消息区恒留 ≥40%（-1px 容差）——#1538 的修复目标本尊
    expect(m.mainH - m.overlayH, `消息可见区应 ≥ main 的 39%`).toBeGreaterThanOrEqual(m.mainH * 0.39)
    // 溢出走卡片内部滚动（内容被收进滚动区而非撑破封顶）
    expect(m.scrollScrollH, '滚动区内容应溢出（scrollHeight > clientHeight）').toBeGreaterThan(m.scrollClientH)
    // 按钮行恒可见可点（#1535 成果不被封顶回退）
    expect(m.btnVisibleInViewport, '发送按钮应在视口内').toBe(true)
    expect(m.btnHit, '发送按钮应可命中').toBe(true)
    // 衬垫按封顶后实高同步（RO 观测的是 clamp 后的实高——无「衬垫按自然高度算」的错位）
    expect(Math.abs(m.spacerH - m.overlayH), '衬垫应等于 overlay 封顶后实高').toBeLessThanOrEqual(2)

    await page.screenshot({ path: 'test-results/ovmh-9-maxed.png' })
  })
})
