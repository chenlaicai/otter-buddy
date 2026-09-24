import { useState, useEffect, useMemo, useRef, useCallback } from 'react'

/**
 * #576（F20260901emps）：数据源 GET /api/skills（ResourceLoader 真相源）。
 * F20260924uxrc 书式改版（搭档拍板）：双页摊开（spread）秘籍书。
 *
 * 检视獭-uxrc2 对抗审视后修复（4 严重全改）：
 * - 翻页队列回放 off-by-one：回放基准改用 viewRef（动画落地后的真实 view），
 *   双击落 2、反向超调、耳直达退化全部修正；setTimeout 存 timerRef 卸载清理
 * - 奇数内容页末页不可达：maxView = sheetCount（最后一张纸可翻），右半露出
 *   底衬页（封二）承载末视野
 * - TOC 条目真实化 + 可点直达（原硬编码 members 会列幻影条目）；门号统一全局序
 * - 秘籍页恢复「心法全文」展开（Precondition 段不再丢失）
 */
interface SkillEntry {
  name: string
  desc: string
}

/** 流派定义：内置归属清单（真实 skill 名 → 流派）；未识别归「外典」 */
const CHAPTERS: { no: string; emoji: string; title: string; en: string; color: string; desc: string; members: string[] }[] = [
  { no: '壹', emoji: '🍃', title: '搭档之道', en: 'COMPANIONSHIP', color: '#7A9A6B',
    desc: '不匹配任何招式时的心法——像朋友一样聊，不端着流程。', members: ['companion'] },
  { no: '贰', emoji: '🔍', title: '信息层', en: 'INFORMATION', color: '#6B8FA3',
    desc: '查与诊——记忆、历史、状态的一切入口。', members: ['core-workflow', 'troubleshooting'] },
  { no: '叁', emoji: '⚒️', title: '修行之路', en: 'CRAFT', color: '#B08A4F',
    desc: '从模糊想法到合入主线——开发的完整流程链。', members: ['requirement-analysis', 'code-implementation', 'worktree-isolation', 'post-merge-cleanup'] },
  { no: '肆', emoji: '🎪', title: '群体协作', en: 'COLLABORATION', color: '#A3756B',
    desc: '多獭共舞——召唤、审视、冲突解决的编排层。', members: ['otter-summon', 'adversarial-review', 'review-protocol', 'conflict-resolution-protocol'] },
  { no: '伍', emoji: '📖', title: '族群法典', en: 'CONVENTIONS', color: '#8B7FA3',
    desc: '查表约定——署名、元规范、视觉设计的唯一真相源。', members: ['signature-convention', 'writing-skills', 'visual-design'] },
]

export interface ParsedSkillDesc {
  when: string | null
  notFor: string | null
  output: string | null
  raw: string
}

/**
 * 解析 SKILL.md frontmatter 三段式 description（writing-skills 契约）。
 * 未识别的文案三段全 null（降级为整段描述，不装模作样拆槽）。
 */
export function parseSkillDescription(desc: string): ParsedSkillDesc {
  const clean = desc.replace(/\s+/g, ' ').trim()
  const when = clean.match(/Use when:\s*(.*?)(?=\s(?:Not for:|Output:|Precondition:)|$)/i)?.[1]?.trim() || null
  const notFor = clean.match(/Not for:\s*(.*?)(?=\s(?:Output:|Precondition:|Use when:)|$)/i)?.[1]?.trim() || null
  const output = clean.match(/Output:\s*(.*?)(?=\s(?:Precondition:|Use when:|Not for:)|$)/i)?.[1]?.trim() || null
  return { when, notFor, output, raw: clean }
}

/** 中文序数（「第 N 门」全局序） */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']
const cnNum = (i: number) => CN_NUM[i] ?? String(i + 1)

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; skills: SkillEntry[]; degraded: boolean }
  | { kind: 'empty' }
  | { kind: 'error' }

/** 页面模型：章目录页与技能页交替；skillIdx 为全局技能序 */
interface PageModel {
  chapter: number
  kind: 'toc' | 'skill'
  /** skill 页：全局技能序号；toc 页：-1 */
  skillIdx: number
}

/** 组页：每章 [目录页, skill页...]；外典章（有未归类 skill 时）动态追加 */
function buildPages(skills: SkillEntry[]): { chapters: typeof CHAPTERS; pages: PageModel[] } {
  const chapters = CHAPTERS.map(c => ({ ...c }))
  const hasOrphan = skills.some(s => !CHAPTERS.some(c => c.members.includes(s.name)))
  if (hasOrphan) {
    chapters.push({ no: cnNum(chapters.length - 1), emoji: '📦', title: '外典', en: 'UNSORTED', color: '#8B7D6B',
      desc: '尚未归入流派的技艺——族群成长中自然出现。', members: [] })
  }
  const pages: PageModel[] = []
  const chapterOf = (name: string) => {
    const known = CHAPTERS.findIndex(c => c.members.includes(name))
    return known >= 0 ? known : chapters.length - 1
  }
  chapters.forEach((_ch, ci) => {
    pages.push({ chapter: ci, kind: 'toc', skillIdx: -1 })
    skills.forEach((s, si) => { if (chapterOf(s.name) === ci) pages.push({ chapter: ci, kind: 'skill', skillIdx: si }) })
  })
  return { chapters, pages }
}

/** 复用样式常量（检视建议：收敛 inline style 重复） */
const PAPER_BG = 'linear-gradient(105deg,rgba(139,111,71,.10),transparent 8%),linear-gradient(255deg,rgba(139,111,71,.07),transparent 8%),#FAF6F0'
const SERIF = 'Georgia,"Songti SC","Noto Serif SC","STSong",serif'
const PAGE_FONT = '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif'
const NAV_BTN: React.CSSProperties = {
  width: 28, height: 28, borderRadius: '50%', border: '1px solid rgba(201,172,142,.4)',
  background: 'none', color: '#C9AC8E', cursor: 'pointer', fontSize: 13,
}

export default function SkillsPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [view, setView] = useState(0) // 0=封面；v≥1 = 摊开 pages[2v-1] | pages[2v]（越界为衬页）
  const [flipping, setFlipping] = useState(false)
  const viewRef = useRef(0) // 真实 view（闭包读，绕开 setState 异步）
  const flippingRef = useRef(false)
  const queueRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/skills')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ skills: { name: string; description: string }[] }>
      })
      .then(data => {
        if (cancelled) return
        if (!data.skills || data.skills.length === 0) { setState({ kind: 'empty' }); return }
        setState({ kind: 'loaded', skills: data.skills.map(s => ({ name: s.name, desc: s.description })), degraded: false })
      })
      .catch(() => { if (!cancelled) setState({ kind: 'error' }) })
    return () => { cancelled = true }
  }, [])

  const skills = useMemo(() => state.kind === 'loaded' ? state.skills : state.kind === 'error' ? FALLBACK_SKILLS : [], [state])
  const degraded = state.kind === 'error'
  const { chapters, pages } = useMemo(() => buildPages(skills), [skills])
  // sheet 组装：总页 = 1 封面 + n 内容页；sheet k = [pages[2k-1]]（k=0 正面为封面）
  const totalContent = pages.length
  const sheetCount = Math.ceil((totalContent + 1) / 2)
  // 末视野可达最后一张纸的背面（奇数内容页时最后的 skill 页在 sheet 末张的背面）——
  // 检视修复：原 sheetCount-1 导致奇数内容页时最后一页永远翻不到
  const maxView = Math.max(1, sheetCount)
  const maxViewRef = useRef(maxView)
  maxViewRef.current = maxView

  /** 翻页引擎（检视修复版）：回放基准 = viewRef（动画落地后的真实值，原 bug 用翻页前 view 丢步）
   *  纯事件驱动无 setState updater 副作用（StrictMode 安全）；timerRef 卸载可清理 */
  const goView = useCallback((target: number) => {
    const cur = viewRef.current
    const t = Math.max(0, Math.min(maxViewRef.current, target))
    if (flippingRef.current) {
      if (t !== cur) queueRef.current += Math.sign(t - cur)
      return
    }
    if (t === cur) return
    flippingRef.current = true
    viewRef.current = t
    setView(t)
    setFlipping(true)
    timerRef.current = setTimeout(() => {
      flippingRef.current = false
      setFlipping(false)
      if (queueRef.current !== 0) {
        const s = queueRef.current
        queueRef.current = 0
        goView(viewRef.current + s) // 回放基准 = 落地后的 viewRef（off-by-one 修复点）
      }
    }, FLIP_MS)
  }, [])
  // 卸载清理（检视建议：路由切走时的 setTimeout 泄漏 + setState-after-unmount）
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  // 键盘翻页
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goView(viewRef.current + 1)
      if (e.key === 'ArrowLeft') goView(viewRef.current - 1)
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [goView])

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="w-6 h-6 border-2 border-otter-300 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (state.kind === 'empty') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <div className="text-4xl">📕</div>
        <div className="text-sm font-medium text-stone-400">未发现任何 skill</div>
        <div className="text-xs text-stone-400">.pi/skills 目录为空或未加载——请检查服务端 skill 加载日志</div>
      </div>
    )
  }

  const lastView = view === maxView
  return (
    <div className="flex flex-1 overflow-hidden"
      style={{ background: 'radial-gradient(ellipse at 50% 30%, #4a3a26 0%, #2A2014 70%)' }}>
      <div style={{
        position: 'relative', width: view === 0 ? 'min(560px, 47vw)' : 'min(1120px, 94vw)',
        height: 'min(720px, 88vh)', margin: 'auto', perspective: '2600px',
        // 书体根不接收事件（preserve-3d 平面会叠在 3D 子元素上方拦截点击——
        // Playwright 实证 skills-book 自己 intercepts pointer events）；
        // 事件入口：当前纸（k===view）/热区/章节耳，各自显式 auto
        pointerEvents: 'none',
        transformStyle: 'preserve-3d', transition: `width ${FLIP_MS}ms cubic-bezier(.5,.05,.3,1)`,
      }} data-testid="skills-book" data-view={view}>
        {/* 厚度堆：已翻（左）|未翻（右）——封面态左堆隐藏（合上的书左侧无厚度） */}
        <div style={{
          position: 'absolute', left: -9, top: `${(100 - Math.min(100, view * 10)) / 2}%`, bottom: `${(100 - Math.min(100, view * 10)) / 2}%`,
          width: 10, borderRadius: '6px 0 0 6px', opacity: view === 0 ? 0 : 1, transition: 'all .5s',
          background: 'repeating-linear-gradient(180deg,#EFE7DA 0 2px,#E2D7C4 2px 3px)', pointerEvents: 'none', zIndex: 1,
        }} />
        <div style={{
          position: 'absolute', right: -9, top: `${(100 - Math.min(100, (maxView - view) * 10)) / 2}%`, bottom: `${(100 - Math.min(100, (maxView - view) * 10)) / 2}%`,
          width: 10, borderRadius: '0 6px 6px 0', transition: 'all .5s',
          background: 'repeating-linear-gradient(180deg,#EFE7DA 0 2px,#E2D7C4 2px 3px)', pointerEvents: 'none', zIndex: 1,
        }} />
        {/* 翻页中段压暗（渲染修复2：纸张背面文字不过分清晰） */}
        {flipping && <div style={{ position: 'absolute', inset: -2, zIndex: 62, background: 'rgba(20,15,8,.22)', borderRadius: 14, pointerEvents: 'none' }} />}
        {/* 底衬页（封二）：末视野右半的衬底——奇数内容页凑双 + 全翻尽时的落点 */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0, right: 0, width: '50%', zIndex: 0,
          background: PAPER_BG, borderRadius: '4px 12px 12px 4px', boxShadow: '2px 3px 16px rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: PAGE_FONT,
        }}>
          {lastView && (
            <div style={{ textAlign: 'center', color: '#8B7D6B' }}>
              <div style={{ fontSize: 34, marginBottom: 10 }}>🦦</div>
              <div className="serif" style={{ fontFamily: SERIF, fontSize: 15, letterSpacing: '.4em' }}>术精于勤 · 獭成于伴</div>
              <div style={{ fontSize: 11, marginTop: 8, letterSpacing: '.2em' }}>心法会演化 · 本册随族群成长</div>
            </div>
          )}
        </div>

        {/* 纸张（sheet k：正面 = pages[2k-1]，k=0 为封面；背面 = pages[2k]） */}
        {Array.from({ length: sheetCount }, (_, k) => {
          const frontIdx = 2 * k - 1 // -1 = 封面
          const backIdx = 2 * k
          const flipped = k < view
          return (
            <div key={k}
              style={{
                position: 'absolute', top: 0, bottom: 0, right: 0,
                width: view === 0 && k === 0 ? '100%' : '50%',
                transformOrigin: 'left center', transformStyle: 'preserve-3d',
                transform: flipped ? 'rotateY(-180deg)' : 'rotateY(0)',
                transition: `transform ${FLIP_MS}ms cubic-bezier(.5,.05,.3,1), width ${FLIP_MS}ms cubic-bezier(.5,.05,.3,1)`,
                zIndex: flipped ? 10 + k : 10 + (sheetCount - k),
                // 非当前视野的纸不拦截点击（叠放页 pointer-events 穿透，原型 v2 同款修复）。
                // 视野 v 的左页 = 第 v-1 张纸的背面，右页 = 第 v 张纸的正面——
                // 两张都可交互（阅读面）；封面态（v=0）只有封面纸本身
                pointerEvents: k === view || k === view - 1 ? 'auto' : 'none',
              }}>
              {frontIdx === -1 ? (
                <CoverFace total={skills.length} chapters={chapters.length} degraded={degraded} />
              ) : (
                <PageFace page={pages[frontIdx] ?? null} chapters={chapters} skills={skills} pad="right" onTOCGo={goView} />
              )}
              <PageFace page={pages[backIdx] ?? null} chapters={chapters} skills={skills} pad="left" onTOCGo={goView} />
            </div>
          )
        })}

        {/* 章节耳 */}
        {chapters.map((ch, i) => {
          const tocPageIdx = pages.findIndex(p => p.chapter === i && p.kind === 'toc')
          const chView = Math.ceil((tocPageIdx + 1) / 2)
          const past = chView < view
          const current = chView === view
          return (
            <button key={i} onClick={() => goView(chView)} title={`直达 ${ch.title}`}
              style={{
                position: 'absolute', [past ? 'left' : 'right']: -14,
                top: `${12 + i * 11}%`, width: 34, height: 44, zIndex: 66,
                borderRadius: past ? '8px 0 0 8px' : '0 8px 8px 0',
                background: ch.color, color: '#FAF6F0', cursor: 'pointer', border: 'none',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, lineHeight: 1.1, boxShadow: '2px 2px 6px rgba(0,0,0,.3)',
                opacity: current ? 1 : 0.82, outline: current ? '2px solid rgba(250,246,240,.5)' : 'none',
                transition: 'opacity .2s', pointerEvents: 'auto',
              }}>
              <span>{ch.emoji}</span>
              <span style={{ fontSize: 9 }}>{ch.no}</span>
            </button>
          )
        })}

        {/* 翻页热区 */}
        <div onClick={() => goView(view + 1)} style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: '18%', zIndex: 65, cursor: 'pointer', pointerEvents: 'auto' }} data-testid="nav-next" />
        <div onClick={() => goView(view - 1)} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '18%', zIndex: 65, cursor: 'pointer', pointerEvents: 'auto' }} data-testid="nav-prev" />

        {/* 页脚导航 */}
        <div style={{
          position: 'absolute', bottom: -40, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', gap: 12, alignItems: 'center', zIndex: 70, color: '#C9AC8E', fontSize: 11,
        }}>
          <button onClick={() => goView(view - 1)} disabled={view === 0} style={{ ...NAV_BTN, opacity: view === 0 ? 0.25 : 1, pointerEvents: 'auto' }}>←</button>
          <span>{view === 0 ? '封面' : `${view} / ${maxView}`}</span>
          <button onClick={() => goView(view + 1)} disabled={view === maxView} style={{ ...NAV_BTN, opacity: view === maxView ? 0.25 : 1, pointerEvents: 'auto' }}>→</button>
        </div>
      </div>
    </div>
  )
}

/** 翻页动画时长（CSS transition 与 JS 回收定时共享，单一真相源） */
const FLIP_MS = 650

/** 封面纸面 */
function CoverFace({ total, chapters, degraded }: { total: number; chapters: number; degraded: boolean }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, overflow: 'hidden',
      borderRadius: '4px 12px 12px 4px', backfaceVisibility: 'hidden',
      background: 'linear-gradient(135deg,#6B5638 0%,#52402C 55%,#3A2E1F 100%)',
      boxShadow: '2px 3px 16px rgba(0,0,0,.35)',
      display: 'flex', flexDirection: 'column', fontFamily: PAGE_FONT,
    }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, margin: 18, border: '1px solid rgba(250,246,240,.25)', borderRadius: '2px 10px 10px 2px', color: '#FAF6F0' }}>
        <div style={{ width: 64, height: 64, border: '2px solid #C9AC8E', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, boxShadow: '0 0 0 6px rgba(201,172,142,.12), inset 0 0 24px rgba(0,0,0,.25)' }}>🦦</div>
        <div style={{ fontFamily: SERIF, fontSize: 36, letterSpacing: '.35em', textIndent: '.35em', fontWeight: 600 }}>獭族能力秘籍</div>
        <div style={{ fontFamily: SERIF, fontSize: 12, letterSpacing: '.5em', textIndent: '.5em', color: '#C9AC8E' }}>OTTER SKILL CODEX</div>
        <div style={{ marginTop: 18, fontSize: 11, color: 'rgba(250,246,240,.55)', letterSpacing: '.2em' }}>
          {degraded ? '离线兜底清单 · ' : ''}{total} 门心法 · {chapters} 大流派
        </div>
        {degraded && <div data-testid="degraded-badge" style={{ fontSize: 10, color: '#D4A574' }}>可能与实际不符</div>}
        <div style={{ marginTop: 26, fontSize: 12, color: '#C9AC8E', animation: 'oc-breathe 2.4s ease-in-out infinite' }}>— 点击右半页或按 → 摊开 —</div>
      </div>
      <style>{`@keyframes oc-breathe{0%,100%{opacity:.45}50%{opacity:1}}`}</style>
    </div>
  )
}

/** 单页纸面：章目录（可点直达）/ 技能秘籍（含全文展开）/ 凑双空白 */
function PageFace({ page, chapters, skills, pad, onTOCGo }: {
  page: PageModel | null
  chapters: typeof CHAPTERS
  skills: SkillEntry[]
  pad: 'left' | 'right'
  onTOCGo: (v: number) => void
}) {
  return (
    <div style={{
      position: 'absolute', inset: 0, overflow: 'hidden',
      borderRadius: pad === 'right' ? '4px 12px 12px 4px' : '12px 4px 4px 12px',
      transform: pad === 'left' ? 'rotateY(180deg)' : undefined,
      backfaceVisibility: 'hidden',
      background: PAPER_BG, boxShadow: '2px 3px 16px rgba(0,0,0,.35)',
      display: 'flex', flexDirection: 'column', fontFamily: PAGE_FONT,
    }}>
      {page === null ? <div style={{ flex: 1 }} /> : page.kind === 'toc' ? (
        <TOCPage chapter={chapters[page.chapter]} skills={skills} chapters={chapters} onGo={onTOCGo} />
      ) : (
        <SkillPage skill={skills[page.skillIdx]} chapter={chapters[page.chapter]} idx={page.skillIdx} />
      )}
      {page !== null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: pad === 'right' ? '10px 40px 14px 46px' : '10px 46px 14px 40px', fontSize: 10.5, color: '#8B7D6B', letterSpacing: '.12em' }}>
          <span>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: chapters[page.chapter].color, marginRight: 6, verticalAlign: 1 }} />
            {chapters[page.chapter].no} · {chapters[page.chapter].title}
          </span>
          <span>{page.kind === 'toc' ? '目 录' : `第${cnNum(page.skillIdx)}门`}</span>
        </div>
      )}
    </div>
  )
}

/** 章目录页：条目来自真实 skill 清单（检视修复：原硬编码 members 会列幻影条目），点击直达该秘籍页 */
function TOCPage({ chapter, chapters, skills, onGo }: {
  chapter: (typeof CHAPTERS)[number]
  chapters: typeof CHAPTERS
  skills: SkillEntry[]
  onGo: (v: number) => void
}) {
  // 本章程内真实 skill 的全局序（与秘籍页「第N门」同一口径）
  const members = skills.map((s, i) => ({ s, i })).filter(({ s }) =>
    CHAPTERS.some(c => c.members.includes(s.name) && c.title === chapter.title) ||
    (!CHAPTERS.some(c => c.members.includes(s.name)) && chapter.title === '外典'))
  // 各成员所在视野：内容页序 → 视野号（view v 左页 = pages[2v-2]，右页 = pages[2v-1]，
  // 故视野号 = floor(内容序/2)+1；检视修复：原实现返回页号+1，直达差一视野）
  const viewIndexOf = (skillGlobalIdx: number) => {
    let c = 0 // 内容页序（0-based，与 buildPages 的 pages[] 一致）
    const chapterOf = (name: string) => {
      const known = CHAPTERS.findIndex(ch => ch.members.includes(name))
      return known >= 0 ? known : chapters.length - 1
    }
    for (let ci = 0; ci < chapters.length; ci++) {
      c++ // 章目录页
      for (let si = 0; si < skills.length; si++) {
        if (chapterOf(skills[si].name) === ci) {
          if (si === skillGlobalIdx) return Math.floor(c / 2) + 1
          c++
        }
      }
    }
    return Math.floor(c / 2) + 1
  }
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '40px 40px 12px 48px', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <div style={{ fontFamily: SERIF, fontSize: 46, color: '#8B6F47', writingMode: 'vertical-rl', lineHeight: 1 }}>{chapter.no}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, letterSpacing: '.4em', color: '#6B5638', marginBottom: 6 }}>{chapter.en}</div>
          <div style={{ fontFamily: SERIF, fontSize: 25, letterSpacing: '.18em', color: '#3A2E1F', fontWeight: 600 }}>{chapter.emoji} {chapter.title}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#8B7D6B' }}>{chapter.desc}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
        {members.length === 0 && <div style={{ fontSize: 12, color: '#8B7D6B', padding: '12px 4px' }}>（本流派暂无技艺——skill 清单演化中）</div>}
        {members.map(({ s, i }) => {
          const p = parseSkillDescription(s.desc)
          return (
            <button key={s.name} onClick={() => onGo(viewIndexOf(i))}
              style={{ display: 'flex', gap: 12, alignItems: 'baseline', width: '100%', textAlign: 'left',
                padding: '11px 4px', borderBottom: '1px dashed rgba(139,111,71,.25)', background: 'none', border: 'none',
                borderTop: 'none', borderLeft: 'none', borderRight: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(139,111,71,.06)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
              <span style={{ fontFamily: SERIF, color: '#8B6F47', fontSize: 12, width: '2.4em', flexShrink: 0 }}>{cnNum(i)}</span>
              <span style={{ flex: 1 }}>
                <span style={{ fontFamily: SERIF, fontSize: 15, color: '#3A2E1F' }}>{s.name}</span>
                {p.when && <span style={{ display: 'block', fontSize: 11.5, color: '#8B7D6B', marginTop: 2 }}>{p.when.split('；')[0].split('。')[0]}</span>}
              </span>
              <span style={{ color: '#8B6F47', fontSize: 12, flexShrink: 0 }}>翻阅 →</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 技能秘籍页：三槽 + 心法全文展开（检视修复：Precondition 段不再丢失） */
function SkillPage({ skill, chapter, idx }: { skill: SkillEntry; chapter: (typeof CHAPTERS)[number]; idx: number }) {
  const p = parseSkillDescription(skill.desc)
  const [open, setOpen] = useState(false)
  const structured = p.when || p.notFor || p.output
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '36px 32px 12px 46px', minHeight: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: '.35em', color: '#6B5638', marginBottom: 8 }}>{chapter.en} · 第{cnNum(idx)}门</div>
      <div style={{ fontFamily: SERIF, fontSize: 26, letterSpacing: '.1em', color: '#3A2E1F', fontWeight: 600, wordBreak: 'break-all' }}>{skill.name}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 10px' }}>
        <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg,transparent,rgba(139,111,71,.4),transparent)' }} />
        <span style={{ fontSize: 9, letterSpacing: '.4em', color: '#8B6F47' }}>秘 籍</span>
        <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg,transparent,rgba(139,111,71,.4),transparent)' }} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {structured ? (
          <>
            {p.when && <Slot label="施展" text={p.when} />}
            {p.notFor && <Slot label="忌用" text={p.notFor} danger />}
            {p.output && <Slot label="产出" text={p.output} />}
          </>
        ) : (
          <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#52402C' }}>{p.raw}</div>
        )}
        <button onClick={() => setOpen(!open)}
          style={{ marginTop: 12, background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontSize: 11, color: '#6B5638', letterSpacing: '.15em', fontFamily: 'inherit', textAlign: 'left' }}>
          {open ? '▾ 收起心法全文' : '▸ 展开心法全文'}
        </button>
        {open && (
          <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.8, color: '#8B7D6B', whiteSpace: 'pre-wrap' }}>
            {skill.desc}
          </div>
        )}
      </div>
    </div>
  )
}

function Slot({ label, text, danger }: { label: string; text: string; danger?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(139,111,71,.12)' }}>
      <span style={{ fontFamily: SERIF, flexShrink: 0, width: 46, textAlign: 'center', fontSize: 12.5, letterSpacing: '.2em', padding: '3px 0', borderRadius: 3, height: 'fit-content',
        border: `1px solid ${danger ? 'rgba(159,59,59,.4)' : 'rgba(139,111,71,.35)'}`,
        color: danger ? '#9F3B3B' : '#6B5638',
        background: danger ? 'rgba(159,59,59,.05)' : 'rgba(139,111,71,.06)' }}>{label}</span>
      <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#52402C' }}>{text}</div>
    </div>
  )
}

/** 内置兜底清单（API 不可达时降级展示；封面带「离线兜底」标注） */
const FALLBACK_SKILLS: SkillEntry[] = [
  { name: 'companion', desc: '不匹配任何 skill 时的兜底模式：自由协作对话。Use when: 输入不匹配其他 skill。Output: 自然对话。' },
  { name: 'core-workflow', desc: '查询对话历史、搜索记忆、记录决策和产出。' },
  { name: 'troubleshooting', desc: '结构化排查：从症状到根因到修复。' },
  { name: 'requirement-analysis', desc: '把模糊意图变成结构化技术方案。' },
  { name: 'code-implementation', desc: '按方案实现功能：代码 PR + 特性文档。' },
  { name: 'worktree-isolation', desc: 'git 追踪文件修改前的 worktree 隔离。' },
  { name: 'post-merge-cleanup', desc: 'PR 合入后的资源回收善后。' },
  { name: 'otter-summon', desc: '召唤小獭执行专项任务。' },
  { name: 'adversarial-review', desc: '对代码变更或设计文档做对抗审视。' },
  { name: 'review-protocol', desc: '对抗审视的编排查表协议。' },
  { name: 'conflict-resolution-protocol', desc: '獭间意见冲突的分型与解决。' },
  { name: 'signature-convention', desc: '外部留痕签名的唯一格式真相源。' },
  { name: 'writing-skills', desc: '关于 skill 的 skill：契约 + 模板 + lint。' },
  { name: 'visual-design', desc: '展示类设计的反泔水方法论。' },
]
