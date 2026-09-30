import { useState, useEffect, useMemo, useRef, useCallback } from 'react'

/**
 * #576（F20260901emps）：数据源 GET /api/skills（ResourceLoader 真相源）。
 * F20260924uxrc 书式改版（搭档拍板）：双页摊开（spread）秘籍书。
 * F20260929scfx 能力库全书（搭档拍板，对话 9eeb7b69）：书重排三编——
 *   卷首·心法总纲（/api/prompts system sections 全文，过长续页）
 *   卷中·招式秘籍（skill 正文全文进正文区，过长续页；五章流派分组保留）
 *   卷末·兵器谱（/api/prompts tools 清单，紧凑列表自动分页）
 * 序号修复：「第N门」按书页实际顺序编号（目录页与各章秘籍页同口径）。
 *
 * 翻页引擎沿用 F20260924uxrc 检视修复版（viewRef 回放基准 + 步进/直达两形态排队）。
 */
interface SkillEntry {
  name: string
  desc: string
  body: string
}

interface SystemSection {
  title: string
  content: string
}

interface ToolEntry {
  name: string
  description: string
}

interface PromptData {
  system: SystemSection[]
  tools: ToolEntry[]
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

/** 三编固定编（卷首/卷末） */
const PART_CODEX = { no: '卷首', emoji: '🧘', title: '心法总纲', en: 'AXIOMS', color: '#5B7A8C' }
const PART_TOOLS = { no: '卷末', emoji: '⚔️', title: '兵器谱', en: 'ARSENAL', color: '#7A6B8C' }

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

/** 中文序数（「第 N 门」按书页顺序编号） */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']
const cnNum = (i: number) => CN_NUM[i] ?? String(i + 1)

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; skills: SkillEntry[]; prompts: PromptData | null; degraded: boolean }
  | { kind: 'empty' }
  | { kind: 'error' }

/**
 * 页面模型：书序内容页（不含封面/底衬）。
 * kind: 'toc' = 总目录（卷首编目）；'chapterToc' = 章目录；'section' = 心法总纲节；
 *       'skill' = 招式秘籍（cont>0 为续页）；'tools' = 兵器谱（cont>0 续页）
 */
interface PageModel {
  kind: 'toc' | 'chapterToc' | 'section' | 'skill' | 'tools'
  /** 所属章序（CHAPTERS 内索引；-1 = 卷首/卷末编） */
  chapter: number
  /** 全局技能序（skill 页；API 数组序，仅作索引用；编号口径见 ord） */
  skillIdx: number
  /** 书序编号（1 起；按 buildPages 组页时 skill 出现的真实顺序，续页共享首页 ord） */
  ord: number
  /** 心法总纲节序（section 页） */
  sectionIdx: number
  /** 兵器谱页序（该页起始 tool 序） */
  toolsIdx: number
  /** 续页序号（0 = 起始页） */
  cont: number
  /** 本页正文文本（续页切片；起始页取源文本） */
  text: string
}

/** 分页粒度：按行装箱，超页高即切页（F20260929scfx 派工单第 7 条） */
const PAGE_TEXT_LINES = 30

/** 将长文本按行装箱为若干页文本（每页 ≤ maxLines 行）。
 *  围栏（``` 包围的代码块）不跨页切：围栏内行随围栏整体入页，超页高时围栏整体移到下页；
 *  超长行按 ~64 字符视觉宽估算折行数（防 wrap 后实际高度超页）。 */
export function paginateText(text: string, maxLines: number = PAGE_TEXT_LINES): string[] {
  const estUnits = (line: string) => Math.max(1, Math.ceil(line.length / 64))
  const lines = text.split('\n')
  const pages: string[] = []
  let cur: string[] = []
  let curUnits = 0
  let inFence = false
  const flush = () => { pages.push(cur.join('\n')); cur = []; curUnits = 0 }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      // 围栏边界：若切换后会超页，先切页（围栏不跨页）
      const need = estUnits(line)
      if (curUnits + need > maxLines && cur.length > 0) flush()
      cur.push(line); curUnits += need
      inFence = !inFence
      continue
    }
    const need = estUnits(line)
    if (curUnits + need > maxLines && cur.length > 0) flush()
    cur.push(line); curUnits += need
  }
  if (cur.length > 0) flush()
  if (pages.length === 0) pages.push('')
  return pages
}

/** 组页：卷首编目 → 心法总纲各节（含续页）→ 各章（章目录 + skill 页含续页）→ 兵器谱（含续页）。
 * 书序编号（ord）：组页时按 skill 实际出现顺序递增，续页共享首页 ord——「第N门」与翻书
 * 遇到的次序严格一致（检视修复：旧版直接用 API 数组序，与 CHAPTERS 分组书序错位）。 */
export function buildPages(skills: SkillEntry[], prompts: PromptData | null): { chapters: typeof CHAPTERS; pages: PageModel[] } {
  const chapters = CHAPTERS.map(c => ({ ...c }))
  const hasOrphan = skills.some(s => !CHAPTERS.some(c => c.members.includes(s.name)))
  if (hasOrphan) {
    chapters.push({ no: '陆', emoji: '📦', title: '外典', en: 'UNSORTED', color: '#8B7D6B',
      desc: '尚未归入流派的技艺——族群成长中自然出现。', members: [] })
  }
  const pages: PageModel[] = []
  const mk = (partial: Omit<PageModel, 'ord'>): PageModel => ({ ord: 0, ...partial })
  let skillOrd = 0
  const chapterOf = (name: string) => {
    const known = CHAPTERS.findIndex(c => c.members.includes(name))
    return known >= 0 ? known : chapters.length - 1
  }

  // 卷首编目页（总目录：三编结构一览）
  pages.push(mk({ kind: 'toc', chapter: -1, skillIdx: -1, sectionIdx: -1, toolsIdx: -1, cont: 0, text: '' }))

  // 卷首·心法总纲：每 section 一页起，过长续页
  const sections = prompts?.system ?? []
  sections.forEach((sec, si) => {
    paginateText(sec.content).forEach((slice, cont) => {
      pages.push(mk({ kind: 'section', chapter: -1, skillIdx: -1, sectionIdx: si, toolsIdx: -1, cont, text: slice }))
    })
  })

  // 卷中·招式秘籍：各章（章目录 + skill 页含续页）
  chapters.forEach((_ch, ci) => {
    pages.push(mk({ kind: 'chapterToc', chapter: ci, skillIdx: -1, sectionIdx: -1, toolsIdx: -1, cont: 0, text: '' }))
    skills.forEach((s, si) => {
      if (chapterOf(s.name) === ci) {
        skillOrd += 1
        const ord = skillOrd
        paginateText(s.body || s.desc).forEach((slice, cont) => {
          pages.push({ kind: 'skill', chapter: ci, skillIdx: si, ord, sectionIdx: -1, toolsIdx: -1, cont, text: slice })
        })
      }
    })
  })

  // 卷末·兵器谱：紧凑列表，自动分页（每页 12 件）
  const tools = prompts?.tools ?? []
  const TOOLS_PER_PAGE = 12
  for (let i = 0; i < tools.length; i += TOOLS_PER_PAGE) {
    pages.push(mk({ kind: 'tools', chapter: -1, skillIdx: -1, sectionIdx: -1, toolsIdx: i, cont: Math.floor(i / TOOLS_PER_PAGE), text: '' }))
  }

  return { chapters, pages }
}

/** 内容页序 → 视野号（view v 左页 = pages[2v-2]，右页 = pages[2v-1]） */
export function viewOfPageIdx(pageIdx: number): number {
  return Math.floor(pageIdx / 2) + 1
}

/** 复用样式常量 */
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
  const queueRef = useRef(QUEUE_EMPTY)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    // F20260929scfx：双源并行拉取（skills + prompts）；prompts 失败降级 null
    // （卷首/卷末编跳过），skills 失败才整书降级
    Promise.all([
      fetch('/api/skills')
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json() as Promise<{ skills: { name: string; description: string; body?: string }[] }>
        }),
      fetch('/api/prompts')
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json() as Promise<PromptData>
        })
        .catch(() => null),
    ])
      .then(([skillsRes, prompts]) => {
        if (cancelled) return
        if (!skillsRes.skills || skillsRes.skills.length === 0) { setState({ kind: 'empty' }); return }
        setState({
          kind: 'loaded',
          skills: skillsRes.skills.map(s => ({ name: s.name, desc: s.description, body: s.body ?? '' })),
          prompts,
          degraded: prompts === null,
        })
      })
      .catch(() => { if (!cancelled) setState({ kind: 'error' }) })
    return () => { cancelled = true }
  }, [])

  const skills = useMemo(() => state.kind === 'loaded' ? state.skills : state.kind === 'error' ? FALLBACK_SKILLS : [], [state])
  const prompts = useMemo(() => state.kind === 'loaded' ? state.prompts : null, [state])
  const degraded = state.kind === 'error' || (state.kind === 'loaded' && state.prompts === null)
  const { chapters, pages } = useMemo(() => buildPages(skills, prompts), [skills, prompts])
  // sheet 组装：总页 = 1 封面 + n 内容页；sheet k = [pages[2k-1]]（k=0 正面为封面）
  const totalContent = pages.length
  const sheetCount = Math.ceil((totalContent + 1) / 2)
  const maxView = Math.max(1, sheetCount)
  const maxViewRef = useRef(maxView)
  maxViewRef.current = maxView

  /** 翻页引擎（F20260924uxrc 检视修复版）：回放基准 = viewRef；步进累计 / 直达覆盖两形态 */
  const goView = useCallback((target: number) => {
    const cur = viewRef.current
    const t = Math.max(0, Math.min(maxViewRef.current, target))
    if (flippingRef.current) {
      if (t === cur) return
      const queued = queueRef.current !== QUEUE_EMPTY ? queueRef.current : cur
      queueRef.current = Math.abs(t - cur) <= 1 ? queued + (t - cur) : t
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
      if (queueRef.current !== QUEUE_EMPTY) {
        const target2 = Math.max(0, Math.min(maxViewRef.current, queueRef.current))
        queueRef.current = QUEUE_EMPTY
        goView(target2)
      }
    }, FLIP_MS)
  }, [])
  // 卸载清理
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
        pointerEvents: 'none',
        transformStyle: 'preserve-3d', transition: `width ${FLIP_MS}ms cubic-bezier(.5,.05,.3,1)`,
      }} data-testid="skills-book" data-view={view}>
        {/* 厚度堆 */}
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
        {flipping && <div style={{ position: 'absolute', inset: -2, zIndex: 62, background: 'rgba(20,15,8,.22)', borderRadius: 14, pointerEvents: 'none' }} />}
        {/* 底衬页（封二） */}
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
                pointerEvents: k === view || k === view - 1 ? 'auto' : 'none',
              }}>
              {frontIdx === -1 ? (
                <CoverFace total={skills.length} chapters={chapters.length} degraded={degraded} />
              ) : (
                <PageFace page={pages[frontIdx] ?? null} chapters={chapters} skills={skills} prompts={prompts} pad="right" onTOCGo={goView} pages={pages} />
              )}
              <PageFace page={pages[backIdx] ?? null} chapters={chapters} skills={skills} prompts={prompts} pad="left" onTOCGo={goView} pages={pages} />
            </div>
          )
        })}

        {/* 编/章耳：卷首 + 各章 + 卷末 */}
        {[
          { emoji: PART_CODEX.emoji, no: PART_CODEX.no, title: PART_CODEX.title, color: PART_CODEX.color,
            pageIdx: pages.findIndex(p => p.kind === 'toc') },
          ...chapters.map((ch, i) => ({
            emoji: ch.emoji, no: ch.no, title: ch.title, color: ch.color,
            pageIdx: pages.findIndex(p => p.kind === 'chapterToc' && p.chapter === i),
          })),
          { emoji: PART_TOOLS.emoji, no: PART_TOOLS.no, title: PART_TOOLS.title, color: PART_TOOLS.color,
            pageIdx: pages.findIndex(p => p.kind === 'tools') },
        ].map((ear, i) => {
          if (ear.pageIdx < 0) return null
          const chView = viewOfPageIdx(ear.pageIdx)
          const past = chView < view
          const current = chView === view
          return (
            <button key={i} onClick={() => goView(chView)} title={`直达 ${ear.title}`}
              style={{
                position: 'absolute', [past ? 'left' : 'right']: -14,
                top: `${8 + i * 8}%`, width: 34, height: 44, zIndex: 66,
                borderRadius: past ? '8px 0 0 8px' : '0 8px 8px 0',
                background: ear.color, color: '#FAF6F0', cursor: 'pointer', border: 'none',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, lineHeight: 1.1, boxShadow: '2px 2px 6px rgba(0,0,0,.3)',
                opacity: current ? 1 : 0.82, outline: current ? '2px solid rgba(250,246,240,.5)' : 'none',
                transition: 'opacity .2s', pointerEvents: 'auto',
              }}>
              <span>{ear.emoji}</span>
              <span style={{ fontSize: 9 }}>{ear.no}</span>
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
/** 排队空哨兵（0 是合法视野号，不能用 0 表示空） */
const QUEUE_EMPTY = -1

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

/** 页眉元信息：编名 + 色标 */
function PageMeta({ page, chapters }: { page: PageModel; chapters: typeof CHAPTERS }) {
  const label =
    page.kind === 'toc' || page.kind === 'section' ? `${PART_CODEX.no} · ${PART_CODEX.title}` :
    page.kind === 'tools' ? `${PART_TOOLS.no} · ${PART_TOOLS.title}` :
    `${chapters[page.chapter].no} · ${chapters[page.chapter].title}`
  const color =
    page.kind === 'toc' || page.kind === 'section' ? PART_CODEX.color :
    page.kind === 'tools' ? PART_TOOLS.color :
    chapters[page.chapter].color
  return { label, color }
}

/** 单页纸面：总目录 / 章目录 / 心法总纲节 / 技能秘籍（含续页） / 兵器谱 */
function PageFace({ page, chapters, skills, prompts, pad, onTOCGo, pages }: {
  page: PageModel | null
  chapters: typeof CHAPTERS
  skills: SkillEntry[]
  prompts: PromptData | null
  pad: 'left' | 'right'
  onTOCGo: (v: number) => void
  pages: PageModel[]
}) {
  const meta = page ? PageMeta({ page, chapters }) : null
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
        <CodexTOCPage skills={skills} prompts={prompts} chapters={chapters} pages={pages} onGo={onTOCGo} />
      ) : page.kind === 'chapterToc' ? (
        <ChapterTOCPage chapter={chapters[page.chapter]} skills={skills} pages={pages} onGo={onTOCGo} />
      ) : page.kind === 'section' ? (
        <SectionPage section={(prompts?.system ?? [])[page.sectionIdx]} idx={page.sectionIdx} cont={page.cont} text={page.text} />
      ) : page.kind === 'tools' ? (
        <ToolsPage tools={prompts?.tools ?? []} startIdx={page.toolsIdx} cont={page.cont} />
      ) : (
        <SkillPage skill={skills[page.skillIdx]} chapter={chapters[page.chapter]} ord={page.ord} cont={page.cont} text={page.text} />
      )}
      {page !== null && meta && (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: pad === 'right' ? '10px 40px 14px 46px' : '10px 46px 14px 40px', fontSize: 10.5, color: '#8B7D6B', letterSpacing: '.12em' }}>
          <span>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: meta.color, marginRight: 6, verticalAlign: 1 }} />
            {meta.label}
          </span>
          <span>{page.kind === 'toc' || page.kind === 'chapterToc' ? '目 录' : page.kind === 'section' ? `第${cnNum(page.sectionIdx)}则` : page.kind === 'tools' ? `兵器 · ${cnNum(page.cont)}` : `第${cnNum(page.ord - 1)}门${page.cont > 0 ? ` · 其${cnNum(page.cont)}` : ''}`}</span>
        </div>
      )}
    </div>
  )
}

/** 总目录页：三编结构一览，点击直达 */
function CodexTOCPage({ skills, prompts, chapters, pages, onGo }: {
  skills: SkillEntry[]
  prompts: PromptData | null
  chapters: typeof CHAPTERS
  pages: PageModel[]
  onGo: (v: number) => void
}) {
  const sections = prompts?.system ?? []
  const tools = prompts?.tools ?? []
  const chapterOf = (name: string) => {
    const known = CHAPTERS.findIndex(c => c.members.includes(name))
    return known >= 0 ? known : chapters.length - 1
  }
  const skillPageIdx = (g: number) => pages.findIndex(p => p.kind === 'skill' && p.skillIdx === g && p.cont === 0)
  const skillOrd = (g: number) => pages.find(p => p.kind === 'skill' && p.skillIdx === g && p.cont === 0)?.ord ?? 0
  const sectionPageIdx = (si: number) => pages.findIndex(p => p.kind === 'section' && p.sectionIdx === si && p.cont === 0)
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '36px 36px 12px 44px', minHeight: 0 }}>
      <div style={{ fontFamily: SERIF, fontSize: 24, letterSpacing: '.2em', color: '#3A2E1F', fontWeight: 600, marginBottom: 4 }}>📜 全帙目录</div>
      <div style={{ fontSize: 11, color: '#8B7D6B', marginBottom: 10 }}>三编结构——卷首心法 · 卷中招式 · 卷末兵器</div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: PART_CODEX.color, fontWeight: 600, letterSpacing: '.15em', marginBottom: 4 }}>{PART_CODEX.emoji} {PART_CODEX.no} · {PART_CODEX.title}（{sections.length} 则）</div>
          {sections.map((sec, si) => (
            <button key={si} onClick={() => onGo(viewOfPageIdx(sectionPageIdx(si)))}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 4px', background: 'none', border: 'none', borderBottom: '1px dashed rgba(139,111,71,.2)', cursor: 'pointer', fontFamily: 'inherit' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(139,111,71,.06)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
              <span style={{ fontSize: 12, color: '#3A2E1F' }}>{sec.title || '卷首语'}</span>
            </button>
          ))}
          {sections.length === 0 && <div style={{ fontSize: 11, color: '#8B7D6B' }}>（心法总纲加载失败——降级跳过）</div>}
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: '#8B6F47', fontWeight: 600, letterSpacing: '.15em', marginBottom: 4 }}>⚒️ 卷中 · 招式秘籍（{skills.length} 门）</div>
          {chapters.map((ch, ci) => {
            const chSkills = skills.map((s, i) => ({ s, i })).filter(({ s }) => chapterOf(s.name) === ci)
            if (chSkills.length === 0) return null
            const chPageIdx = pages.findIndex(p => p.kind === 'chapterToc' && p.chapter === ci)
            return (
              <div key={ci} style={{ marginBottom: 4 }}>
                <button onClick={() => onGo(viewOfPageIdx(chPageIdx))}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '3px 4px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(139,111,71,.06)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
                  <span style={{ fontFamily: SERIF, fontSize: 12.5, color: ch.color }}>{ch.no} · {ch.title}</span>
                  <span style={{ fontSize: 11, color: '#8B7D6B', marginLeft: 8 }}>{chSkills.length} 门</span>
                </button>
                {chSkills.map(({ s, i }) => (
                  <button key={s.name} onClick={() => onGo(viewOfPageIdx(skillPageIdx(i)))}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '2px 4px 2px 20px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(139,111,71,.06)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
                    <span style={{ fontSize: 11.5, color: '#52402C' }}>第{cnNum(skillOrd(i) - 1)}门 · {s.name}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
        <div>
          <div style={{ fontSize: 12, color: PART_TOOLS.color, fontWeight: 600, letterSpacing: '.15em', marginBottom: 4 }}>{PART_TOOLS.emoji} {PART_TOOLS.no} · {PART_TOOLS.title}（{tools.length} 件）</div>
          {tools.length > 0 && (
            <button onClick={() => onGo(viewOfPageIdx(pages.findIndex(p => p.kind === 'tools')))}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 4px', background: 'none', border: 'none', borderBottom: '1px dashed rgba(139,111,71,.2)', cursor: 'pointer', fontFamily: 'inherit' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(139,111,71,.06)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
              <span style={{ fontSize: 12, color: '#3A2E1F' }}>无条件基础工具集（name + 描述）</span>
            </button>
          )}
          {tools.length === 0 && <div style={{ fontSize: 11, color: '#8B7D6B' }}>（兵器谱加载失败——降级跳过）</div>}
        </div>
      </div>
    </div>
  )
}

/** 章目录页：本章程内 skill 一览（页序编号），点击直达秘籍页 */
function ChapterTOCPage({ chapter, skills, pages, onGo }: {
  chapter: (typeof CHAPTERS)[number]
  skills: SkillEntry[]
  pages: PageModel[]
  onGo: (v: number) => void
}) {
  const members = skills.map((s, i) => ({ s, i })).filter(({ s }) =>
    CHAPTERS.some(c => c.members.includes(s.name) && c.title === chapter.title) ||
    (!CHAPTERS.some(c => c.members.includes(s.name)) && chapter.title === '外典'))
  const skillPageIdx = (g: number) => pages.findIndex(p => p.kind === 'skill' && p.skillIdx === g && p.cont === 0)
  const skillOrd = (g: number) => pages.find(p => p.kind === 'skill' && p.skillIdx === g && p.cont === 0)?.ord ?? 0
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
            <button key={s.name} onClick={() => onGo(viewOfPageIdx(skillPageIdx(i)))}
              style={{ display: 'flex', gap: 12, alignItems: 'baseline', width: '100%', textAlign: 'left',
                padding: '11px 4px', borderBottom: '1px dashed rgba(139,111,71,.25)', background: 'none',
                border: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(139,111,71,.06)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none' }}>
              <span style={{ fontFamily: SERIF, color: '#8B6F47', fontSize: 12, width: '2.4em', flexShrink: 0 }}>{cnNum(skillOrd(i) - 1)}</span>
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

/** 心法总纲节页：SYSTEM.md 二级标题一节，正文全文（12px 容纳，过长续页） */
function SectionPage({ section, idx, cont, text }: { section: SystemSection | undefined; idx: number; cont: number; text: string }) {
  if (!section) return <div style={{ flex: 1, padding: 40 }}>（节缺失）</div>
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '32px 32px 12px 44px', minHeight: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: '.35em', color: PART_CODEX.color, marginBottom: 6 }}>{PART_CODEX.en} · 第{cnNum(idx)}则{cont > 0 ? ` · 其${cnNum(cont)}` : ''}</div>
      <div style={{ fontFamily: SERIF, fontSize: 21, letterSpacing: '.08em', color: '#2A2014', fontWeight: 600, marginBottom: 10 }}>{section.title || '卷首语'}</div>
      <div style={{ flex: 1, overflowY: 'auto', fontSize: 12, lineHeight: 1.75, color: '#3A2E1F', whiteSpace: 'pre-wrap' }}>
        {text}
      </div>
    </div>
  )
}

/** 技能秘籍页：三槽摘要 + 正文全文（过长续页切片）；ord = 书序编号（组页顺序） */
function SkillPage({ skill, chapter, ord, cont, text }: { skill: SkillEntry; chapter: (typeof CHAPTERS)[number]; ord: number; cont: number; text: string }) {
  const p = parseSkillDescription(skill.desc)
  const structured = p.when || p.notFor || p.output
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '32px 32px 12px 44px', minHeight: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: '.35em', color: '#6B5638', marginBottom: 6 }}>{chapter.en} · 第{cnNum(ord - 1)}门{cont > 0 ? ` · 其${cnNum(cont)}` : ''}</div>
      <div style={{ fontFamily: SERIF, fontSize: cont > 0 ? 16 : 24, letterSpacing: '.08em', color: '#3A2E1F', fontWeight: 600, wordBreak: 'break-all' }}>
        {skill.name}{cont > 0 && <span style={{ fontSize: 12, color: '#8B7D6B', marginLeft: 8 }}>（续）</span>}
      </div>
      {cont === 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0 8px' }}>
          <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg,transparent,rgba(139,111,71,.4),transparent)' }} />
          <span style={{ fontSize: 9, letterSpacing: '.4em', color: '#8B6F47' }}>秘 籍</span>
          <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg,transparent,rgba(139,111,71,.4),transparent)' }} />
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {cont === 0 && structured && (
          <>
            {p.when && <Slot label="施展" text={p.when} />}
            {p.notFor && <Slot label="忌用" text={p.notFor} danger />}
            {p.output && <Slot label="产出" text={p.output} />}
          </>
        )}
        <div style={{ marginTop: cont === 0 && structured ? 10 : 0, fontSize: 12, lineHeight: 1.75, color: '#3A2E1F', whiteSpace: 'pre-wrap' }}>
          {text}
        </div>
      </div>
    </div>
  )
}

/** 兵器谱页：工具紧凑列表（每页 12 件） */
function ToolsPage({ tools, startIdx, cont }: { tools: ToolEntry[]; startIdx: number; cont: number }) {
  const pageTools = tools.slice(startIdx, startIdx + 12)
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '32px 32px 12px 44px', minHeight: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: '.35em', color: PART_TOOLS.color, marginBottom: 6 }}>{PART_TOOLS.en}{cont > 0 ? ` · 其${cnNum(cont)}` : ''}</div>
      <div style={{ fontFamily: SERIF, fontSize: 22, letterSpacing: '.12em', color: '#2A2014', fontWeight: 600, marginBottom: 4 }}>{PART_TOOLS.emoji} 兵器谱</div>
      <div style={{ fontSize: 11, color: '#8B7D6B', marginBottom: 8 }}>无条件基础工具 {tools.length} 件</div>
      <div style={{ fontSize: 10.5, lineHeight: 1.7, color: '#8B7D6B', marginBottom: 10, padding: '6px 10px', background: 'rgba(139,111,71,.05)', borderRadius: 4 }}>
        另有条件注册的环境工具——healing（健康自愈）、workspace_*（獭工作区）、create_scheduled_task（定时任务）、query_signals / halt / resolve_signal（獭间信号）等，依运行时环境挂载，不在本谱。
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {pageTools.map((t) => (
          <div key={t.name} style={{ padding: '7px 0', borderBottom: '1px solid rgba(139,111,71,.12)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#3A2E1F', fontFamily: 'monospace' }}>{t.name}</div>
            <div style={{ fontSize: 11, lineHeight: 1.6, color: '#8B7D6B', marginTop: 2 }}>{t.description.slice(0, 120)}{t.description.length > 120 ? '…' : ''}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Slot({ label, text, danger }: { label: string; text: string; danger?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid rgba(139,111,71,.12)' }}>
      <span style={{ fontFamily: SERIF, flexShrink: 0, width: 46, textAlign: 'center', fontSize: 12.5, letterSpacing: '.2em', padding: '3px 0', borderRadius: 3, height: 'fit-content',
        border: `1px solid ${danger ? 'rgba(159,59,59,.4)' : 'rgba(139,111,71,.35)'}`,
        color: danger ? '#9F3B3B' : '#6B5638',
        background: danger ? 'rgba(159,59,59,.05)' : 'rgba(139,111,71,.06)' }}>{label}</span>
      <div style={{ fontSize: 12, lineHeight: 1.7, color: '#52402C' }}>{text}</div>
    </div>
  )
}

/** 内置兜底清单（API 不可达时降级展示；封面带「离线兜底」标注） */
const FALLBACK_SKILLS: SkillEntry[] = [
  { name: 'companion', desc: '不匹配任何 skill 时的兜底模式：自由协作对话。Use when: 输入不匹配其他 skill。Output: 自然对话。', body: '' },
  { name: 'core-workflow', desc: '查询对话历史、搜索记忆、记录决策和产出。', body: '' },
  { name: 'troubleshooting', desc: '结构化排查：从症状到根因到修复。', body: '' },
  { name: 'requirement-analysis', desc: '把模糊意图变成结构化技术方案。', body: '' },
  { name: 'code-implementation', desc: '按方案实现功能：代码 PR + 特性文档。', body: '' },
  { name: 'worktree-isolation', desc: 'git 追踪文件修改前的 worktree 隔离。', body: '' },
  { name: 'post-merge-cleanup', desc: 'PR 合入后的资源回收善后。', body: '' },
  { name: 'otter-summon', desc: '召唤小獭执行专项任务。', body: '' },
  { name: 'adversarial-review', desc: '对代码变更或设计文档做对抗审视。', body: '' },
  { name: 'review-protocol', desc: '对抗审视的编排查表协议。', body: '' },
  { name: 'conflict-resolution-protocol', desc: '獭间意见冲突的分型与解决。', body: '' },
  { name: 'signature-convention', desc: '外部留痕签名的唯一格式真相源。', body: '' },
  { name: 'writing-skills', desc: '关于 skill 的 skill：契约 + 模板 + lint。', body: '' },
  { name: 'visual-design', desc: '展示类设计的反泔水方法论。', body: '' },
]
