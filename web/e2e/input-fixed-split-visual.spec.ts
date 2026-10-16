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
 */
import { test, expect } from '@playwright/test'

/** mock /api：一条会话（消息走 entries）——SPA 正常渲染 ChatView + 输入覆盖层。
 *  匹配纪律：URL 解析后判 pathname 以 '/api/' 开头——裸正则 /\/api\// 会把
 *  '/src/api/client.ts' 模块也吞成 JSON → MIME 错误白屏（实测踩坑）；vite 的 `@fs`
 *  模块请求 pathname 不以 /api/ 开头，天然不命中。
 *  DTO 形状对齐 api-contract：ConversationListItemDTO / EntryDTO / ParticipantDTO /
 *  KeyInfoDTO / UnreadStateDTO / InvokeListResponseDTO / SettingsDTO */
async function mockApi(page: import('@playwright/test').Page) {
  await page.route(url => {
    try { return new URL(url).pathname.startsWith('/api/') } catch { return false }
  }, async route => {
    const url = route.request().url()
    let json: unknown = {}
    if (/\/api\/conversations(\/|$|\?)/.test(url) && !url.includes('/entries') && !url.includes('/participants') && !url.includes('/key-resources') && !url.includes('/unread') && !url.includes('/read') && !url.includes('/invokes') && !url.includes('/scheduled-tasks') && !url.includes('/resources') && !url.includes('/messages')) {
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
        body: `消息 ${i + 1}：视觉自查行 ${'█'.repeat(20 + (i % 5))}`,
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
async function openConversation(page: import('@playwright/test').Page) {
  await mockApi(page)
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
