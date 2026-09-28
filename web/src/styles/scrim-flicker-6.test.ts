/**
 * F20260909scrf6：弹窗期模糊语义切换的样式契约测试。
 * 背景：backdrop-filter 实时采样下层位图，任何漏网变化源（流式计时器等）都会
 * 造成「清晰帧↔模糊帧」跳变闪烁——白名单冻结补 5 轮仍漏网。
 * 修复：body.modal-open 期间内容区自模糊（filter:blur）+ scrim 摘掉 backdrop-filter。
 * 本测试锁定 globals.css 中这两条规则的共存，防止回退引入旧语义。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../styles/globals.css'), 'utf-8')

describe('F20260909scrf6：弹窗期内容自模糊样式契约', () => {
  it('modal-open 期间内容区挂 filter:blur（等效 scrim 模糊 token）', () => {
    expect(css).toMatch(
      /body\.modal-open\s+\[data-testid='app-content-scroll'\]\s*\{\s*filter:\s*var\(--scrim-blur\)/
    )
  })

  it('modal-open 期间 scrim 摘掉 backdrop-filter（不再实时采样）', () => {
    expect(css).toMatch(
      /body\.modal-open\s+\.scrim\s*\{\s*backdrop-filter:\s*none/
    )
  })

  it('reduced-transparency 下内容区不加模糊（无障碍全实色语义不回归）', () => {
    expect(css).toMatch(
      /prefers-reduced-transparency:\s*reduce[\s\S]*?body\.modal-open\s+\[data-testid='app-content-scroll'\]\s*\{\s*filter:\s*none/
    )
  })

  it('旧降级开关注释已退役（防双语义并存）', () => {
    expect(css).not.toMatch(/\/\*\s*body\.modal-open\s+\.scrim\s*\{\s*backdrop-filter:\s*none[^}]*\}\s*\*\//)
  })
})

/** 冻结链标识 pattern（r3-C2）：模块级单一真相源，契约用例与 corpus 自测共用 */
const FREEZE_CHAIN_PATTERN = /modalOpen|isAnyModalOpen|runOrDefer|flushDeferredOps|getShouldDefer/

/**
 * F20260929fcln（#884）：冻结链退役契约。
 * 背景：F20260909srf6 模糊语义换轨（scrim 采样 → 内容自模糊）后，前五轮为保
 * scrim 采样准静态而建的冻结机制全部失去服务对象——本轮清理：
 * - globals.css：body.modal-open .stream-shimmer 冻结规则 + 孤儿类定义（挂载点
 *   已随 #886 对话视图重构退役）全删
 * - index.tsx：batcher defer / 轮询 gate / deferred ops / 关窗 flush 全拆
 *   （app-content-scroll 包含整个 <Outlet />，全部背景更新都在模糊层内，无采样失效）
 * 本组断言锁定清理不被回退（防止「顺手」恢复冻结式写法重新引入双轨语义）。
 */
describe('F20260929fcln：冻结链退役契约（#884）', () => {
  it('stream-shimmer 冻结规则与孤儿类定义已全删（globals.css 零命中）', () => {
    expect(css).not.toMatch(/stream-shimmer/)
    expect(css).not.toMatch(/streamShimmer/)
  })

  it('「冻结式」modal-open 规则不再存在（modal-open 仅承载内容自模糊语义）', () => {
    // modal-open 相关规则只允许：内容自模糊 / scrim 摘 backdrop-filter / reduced-transparency 免模糊
    // （第三个在 @media 块内缩进，允许行首空白）
    const modalOpenRules = css.match(/^\s*body\.modal-open[^{]*\{[^}]*\}/gm) ?? []
    for (const rule of modalOpenRules) {
      const isAllowed = /filter:\s*var\(--scrim-blur\)/.test(rule)
        || /backdrop-filter:\s*none/.test(rule)
        || /filter:\s*none/.test(rule)
      expect(isAllowed, `unexpected modal-open rule: ${rule}`).toBe(true)
    }
    expect(modalOpenRules.length).toBeGreaterThanOrEqual(3)
  })

  it('useDeferredOps 冻结队列 hook 已删（文件不存在）', () => {
    expect(existsSync(resolve(__dirname, '../pages/conversation/hooks/useDeferredOps.ts'))).toBe(false)
  })

  it('useScheduledTasks 已退 enabled 形参（弹窗期不再暂停拉取/轮询）', () => {
    const hook = readFileSync(resolve(__dirname, '../pages/conversation/hooks/useScheduledTasks.ts'), 'utf-8')
    expect(hook).not.toMatch(/enabled/)
  })

  it('conversation/index.tsx 已拆冻结链（无 modalOpen 派生/门控、无 runOrDefer、无关窗 flush）', () => {
    const page = readFileSync(resolve(__dirname, '../pages/conversation/index.tsx'), 'utf-8')
    // 裸子串匹配：modalOpen / modalOpenRef / setModalOpen 全形态覆盖，
    // isAnyModalOpen 因大写 M 不被裸子串命中（r3-C1）需显式列出。
    // 不能用 \b 词边界——\bmodalOpen\b 对 modalOpenRef 不命中（r2-D1 实证）。
    // 当前文件零命中，误报零
    expect(page).not.toMatch(FREEZE_CHAIN_PATTERN)
  })

  it('C2 corpus 自测：冻结链标识 pattern 对全形态语料有区分度（终结三轮形态漂移）', () => {
    // 正向语料（历史真实/变体形态）全命中，负向语料（无关词样）零命中——
    // pattern 变更时本用例先红，不再依赖「每轮手工注入两三个形态」的抽查式验证
    const FREEZE_PATTERN = FREEZE_CHAIN_PATTERN
    const positive = [
      'if (modalOpen) return',                        // 裸门控（r2-D1 验收点 2）
      'if (modalOpenRef.current) return',              // ref 镜像（历史真实形态，r2-D1 验收点 1）
      'const [modalOpen, setModalOpen] = useState(false)', // state 声明
      'const isAnyModalOpen = modal.type !== \'none\'',  // 派生（r3-C1）
      'runOrDefer(() => setAllOtters(apply))',         // 延迟队列（F20260827scrf2）
      'flushDeferredOps()',                            // 关窗 flush
      'getShouldDefer: () => modalOpenRef.current',    // batcher defer 参数（F20260825scrf）
    ]
    const negative = [
      'useConversationListPolling(enabled, setConversations, visibleConvIds)',
      'const modalType = modal.type',
      'ScheduledTaskModal',
      'ExecutionHistoryModal',
      'openModal()',
      'closeModal()',
    ]
    for (const p of positive) {
      expect(FREEZE_PATTERN.test(p), `positive corpus should match: ${p}`).toBe(true)
    }
    for (const n of negative) {
      expect(FREEZE_PATTERN.test(n), `negative corpus should NOT match: ${n}`).toBe(false)
    }
  })

  it('conversation/index.tsx 保留关窗后流式追上能力：batcher 语义未削弱（50ms 窗口仍在）', () => {
    const page = readFileSync(resolve(__dirname, '../pages/conversation/index.tsx'), 'utf-8')
    expect(page).toMatch(/BATCH_WINDOW_MS = 50/)  
    expect(page).toMatch(/batchUpdateMessages/)
  })
})
