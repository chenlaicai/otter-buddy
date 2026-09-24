import { useState, useEffect, useMemo, useRef, useCallback } from 'react'

/**
 * #576（F20260901emps）：数据源 GET /api/skills（ResourceLoader 真相源）。
 * F20260924uxrc 书式改版（搭档拍板）：双页摊开（spread）秘籍书替代 v1 卡片阵。
 *  - 封面（合上的书，半宽居中）→ 摊开：左页+右页同框，纸张 3D 掠过中线
 *  - 连续性三件套：双页同框 / 书脊两侧厚度堆（已翻|未翻）/ 章节索引耳（点耳直达）
 *  - 渲染修复（搭档 15:52 反馈）：封面态无左侧白边（厚度公式修正+封面占满书体）；
 *    翻页中段全书压暗（纸张背面文字不再清晰闪过）
 *  - 分组与文案：skill 归属五流派（与海獭面板装备槽同语言），三段式 description
 *    解析成 施展/忌用/产出 三槽（忌用朱砂红）
 *  - 降级链不变（#576 契约）：API 成功 → 真实清单；失败 → 内置兜底（「离线兜底」标注）；
 *    空 → 显式空态文案
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
 * 未识别的文案三段全 null（卡片降级为整段描述，不装模作样拆槽）。
 */
export function parseSkillDescription(desc: string): ParsedSkillDesc {
  const clean = desc.replace(/\s+/g, ' ').trim()
  const when = clean.match(/Use when:\s*(.*?)(?=\s(?:Not for:|Output:|Precondition:)|$)/i)?.[1]?.trim() || null
  const notFor = clean.match(/Not for:\s*(.*?)(?=\s(?:Output:|Precondition:|Use when:)|$)/i)?.[1]?.trim() || null
  const output = clean.match(/Output:\s*(.*?)(?=\s(?:Precondition:|Use when:|Not for:)|$)/i)?.[1]?.trim() || null
  return { when, notFor, output, raw: clean }
}

/** 中文序数（技能页脚「第 N 门」用） */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; skills: SkillEntry[]; degraded: boolean }
  | { kind: 'empty' }
  | { kind: 'error' }

/** skill → 流派索引；未识别返回 null（归「外典」章） */
function findChapter(name: string): number | null {
  for (let i = 0; i < CHAPTERS.length; i++) {
    if (CHAPTERS[i].members.includes(name)) return i
  }
  return null
}

/** 页面模型：{ 章索引, 类型, skill? }；章目录页与技能页交替，外典章（若有）排最后 */
interface PageModel { chapter: number; kind: 'toc' | 'skill'; skillIdx: number }

/** 把 skill 列表组页：每章 [目录页, skill页...]，外典 skill（若有）合成一章 */
function buildPages(skills: SkillEntry[]): { chapters: typeof CHAPTERS; pages: PageModel[]; skillChap: number[] } {
  const chapters = CHAPTERS.map(c => ({ ...c }))
  const grouped = skills.map(s => findChapter(s.name))
  const orphans = skills.filter((_, i) => grouped[i] === null)
  if (orphans.length > 0) {
    chapters.push({ no: chapters.length >= 5 ? '陆' : '陆', emoji: '📦', title: '外典', en: 'UNSORTED', color: '#8B7D6B',
      desc: '尚未归入流派的技艺——族群成长中自然出现。', members: orphans.map(o => o.name) })
  }
  const pages: PageModel[] = []
  const skillChap: number[] = [] // 全局技能序号 → 章
  chapters.forEach((ch, ci) => {
    pages.push({ chapter: ci, kind: 'toc', skillIdx: -1 })
    skills.forEach((s, si) => {
      if (findChapter(s.name) === ci || (ci === chapters.length - 1 && findChapter(s.name) === null)) {
        pages.push({ chapter: ci, kind: 'skill', skillIdx: si })
        skillChap[si] = ci
      }
    })
  })
  return { chapters, pages, skillChap }
}

export default function SkillsPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [view, setView] = useState(0) // 0=封面；v≥1 = 摊开 p(2v-1)|p(2v)
  const [flipping, setFlipping] = useState(false)
  const flippingRef = useRef(false)
  const queueRef = useRef(0)

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
  const { chapters, pages, skillChap } = useMemo(() => buildPages(skills), [skills])
  // 凑双页：总页 = 1 封面 + 内容页，末尾补后记/封底凑双；maxView = 最后一个完整摊开视野
  const totalContent = pages.length
  const sheetCount = Math.ceil((totalContent + 1) / 2)
  const maxView = Math.max(1, sheetCount - 1)

  const goView = useCallback((target: number) => {
    setView(prev => {
      const t = Math.max(0, Math.min(maxView, target))
      if (flippingRef.current) { queueRef.current += Math.sign(t - prev); return prev }
      if (t === prev) return prev
      flippingRef.current = true
      setFlipping(true)
      setTimeout(() => {
        flippingRef.current = false
        setFlipping(false)
        if (queueRef.current !== 0) {
          const s = queueRef.current; queueRef.current = 0
          goView(Math.max(0, Math.min(maxView, prev + s)))
        }
      }, 650)
      return t
    })
  }, [maxView])
  // 键盘翻页
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goView(view + 1)
      if (e.key === 'ArrowLeft') goView(view - 1)
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [view, maxView, goView])

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

  

  return (
    <div className="skills-book-wrap flex-1 flex flex-col overflow-hidden"
      style={{ background: 'radial-gradient(ellipse at 50% 30%, #4a3a26 0%, #2A2014 70%)' }}>
      {/* 书体 */}
      <div className="skills-book" data-view={view} data-flipping={flipping ? 1 : 0}
        style={{
          position: 'relative', width: view === 0 ? 'min(560px, 47vw)' : 'min(1120px, 94vw)',
          height: 'min(720px, 88vh)', margin: 'auto', perspective: '2600px',
          transformStyle: 'preserve-3d',
          transition: 'width .65s cubic-bezier(.5,.05,.3,1)',
        }}>
        {/* 厚度堆 */}
        <div style={{
          position: 'absolute', left: -9, top: `${(100 - Math.min(100, view * 10)) / 2}%`, bottom: `${(100 - Math.min(100, view * 10)) / 2}%`,
          width: 10, borderRadius: '6px 0 0 6px', opacity: view === 0 ? 0 : 1, transition: 'all .5s',
          background: 'repeating-linear-gradient(180deg,#EFE7DA 0 2px,#E2D7C4 2px 3px)', pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', right: -9, top: `${(100 - Math.min(100, (maxView - view) * 10)) / 2}%`, bottom: `${(100 - Math.min(100, (maxView - view) * 10)) / 2}%`,
          width: 10, borderRadius: '0 6px 6px 0', transition: 'all .5s',
          background: 'repeating-linear-gradient(180deg,#EFE7DA 0 2px,#E2D7C4 2px 3px)', pointerEvents: 'none',
        }} />
        {/* 翻页中段压暗层（渲染修复2：纸张背面文字不过分清晰） */}
        {flipping && <div style={{ position: 'absolute', inset: -2, zIndex: 62, background: 'rgba(20,15,8,.22)', borderRadius: 14, pointerEvents: 'none' }} />}

        {/* 纸张 */}
        {Array.from({ length: Math.ceil((totalContent + 1) / 2) }, (_, k) => {
          const frontIdx = 2 * k, backIdx = 2 * k + 1
          const flipped = k < view
          return (
            <div key={k} className="sheet"
              style={{
                position: 'absolute', top: 0, bottom: 0, right: 0,
                width: view === 0 && k === 0 ? '100%' : '50%',
                transformOrigin: 'left center', transformStyle: 'preserve-3d',
                transform: flipped ? 'rotateY(-180deg)' : 'rotateY(0)',
                transition: 'transform .6s cubic-bezier(.5,.05,.3,1), width .6s cubic-bezier(.5,.05,.3,1)',
                zIndex: flipped ? 10 + k : 10 + (Math.ceil((totalContent + 1) / 2) - k),
              }}>
              {/* 正面 */}
              <PageFace page={frontIdx === 0 ? null : pages[frontIdx - 1] ?? null}
                chapters={chapters} skills={skills} skillChap={skillChap}
                cover={frontIdx === 0 ? { total: skills.length, chapters: chapters.length, degraded } : undefined}
                pad="right" />
              {/* 背面 */}
              <PageFace page={pages[backIdx - 1] ?? null} chapters={chapters} skills={skills} skillChap={skillChap}
                pad="left" />
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
                background: ch.color, color: '#FAF6F0', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, lineHeight: 1.1, boxShadow: '2px 2px 6px rgba(0,0,0,.3)',
                opacity: current ? 1 : 0.82, outline: current ? '2px solid rgba(250,246,240,.5)' : 'none',
                transition: 'opacity .2s',
              }}>
              <span>{ch.emoji}</span>
              <span style={{ fontSize: 9 }}>{ch.no}</span>
            </button>
          )
        })}

        {/* 翻页热区 */}
        <div onClick={() => goView(view + 1)} style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: '18%', zIndex: 65, cursor: 'pointer' }} />
        <div onClick={() => goView(view - 1)} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '18%', zIndex: 65, cursor: 'pointer' }} />

        {/* 页脚导航 */}
        <div style={{
          position: 'absolute', bottom: -40, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', gap: 12, alignItems: 'center', zIndex: 70, color: '#C9AC8E', fontSize: 11,
        }}>
          <button onClick={() => goView(view - 1)} disabled={view === 0}
            style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid rgba(201,172,142,.4)', background: 'none', color: '#C9AC8E', cursor: 'pointer' }}>←</button>
          <span>{view === 0 ? '封面' : `${view} / ${maxView}`}</span>
          <button onClick={() => goView(view + 1)} disabled={view === maxView}
            style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid rgba(201,172,142,.4)', background: 'none', color: '#C9AC8E', cursor: 'pointer' }}>→</button>
        </div>
      </div>
    </div>
  )
}

/** 单页纸面：封面 / 章目录 / 技能秘籍 / 凑双空白页 */
function PageFace({ page, chapters, skills, skillChap, cover, pad }: {
  page: PageModel | null
  chapters: typeof CHAPTERS
  skills: SkillEntry[]
  skillChap: number[]
  cover?: { total: number; chapters: number; degraded: boolean }
  pad: 'left' | 'right'
}) {
  const paperBg = 'linear-gradient(105deg,rgba(139,111,71,.10),transparent 8%),linear-gradient(255deg,rgba(139,111,71,.07),transparent 8%),#FAF6F0'
  const isCover = !!cover
  return (
    <div style={{
      position: 'absolute', inset: 0, overflow: 'hidden',
      borderRadius: pad === 'right' ? '4px 12px 12px 4px' : '12px 4px 4px 12px',
      transform: pad === 'left' ? 'rotateY(180deg)' : undefined,
      backfaceVisibility: 'hidden',
      background: isCover ? 'linear-gradient(135deg,#6B5638 0%,#52402C 55%,#3A2E1F 100%)' : paperBg,
      boxShadow: '2px 3px 16px rgba(0,0,0,.35)',
      display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
    }}>
      {isCover ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, margin: 18, border: '1px solid rgba(250,246,240,.25)', borderRadius: '2px 10px 10px 2px', color: '#FAF6F0' }}>
          <div style={{ width: 64, height: 64, border: '2px solid #C9AC8E', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, boxShadow: '0 0 0 6px rgba(201,172,142,.12), inset 0 0 24px rgba(0,0,0,.25)' }}>🦦</div>
          <div className="serif" style={{ fontSize: 36, letterSpacing: '.35em', textIndent: '.35em', fontWeight: 600 }}>獭族能力秘籍</div>
          <div className="serif" style={{ fontSize: 12, letterSpacing: '.5em', textIndent: '.5em', color: '#C9AC8E' }}>OTTER SKILL CODEX</div>
          <div style={{ marginTop: 18, fontSize: 11, color: 'rgba(250,246,240,.55)', letterSpacing: '.2em' }}>
            {cover.degraded ? '离线兜底清单 · ' : ''}{cover.total} 门心法 · {cover.chapters} 大流派
          </div>
          {cover.degraded && (
            <div data-testid="degraded-badge" style={{ fontSize: 10, color: '#D4A574' }}>可能与实际不符</div>
          )}
          <div style={{ marginTop: 26, fontSize: 12, color: '#C9AC8E', animation: 'oc-breathe 2.4s ease-in-out infinite' }}>— 点击右半页或按 → 摊开 —</div>
        </div>
      ) : page === null ? (
        <div style={{ flex: 1 }} /> // 凑双空白页（尾页）
      ) : page.kind === 'toc' ? (
        <TOCPage chapter={chapters[page.chapter]} />
      ) : (
        <SkillPage skill={skills[page.skillIdx]} chapter={chapters[skillChap[page.skillIdx]]} idx={page.skillIdx} />
      )}
      {/* 页脚 */}
      {!isCover && page !== null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: pad === 'right' ? '10px 40px 14px 46px' : '10px 46px 14px 40px', fontSize: 10.5, color: '#8B7D6B', letterSpacing: '.12em' }}>
          <span>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: chapters[page.chapter].color, marginRight: 6, verticalAlign: 1 }} />
            {chapters[page.chapter].no} · {chapters[page.chapter].title}
          </span>
          <span>{page.kind === 'toc' ? '目 录' : `第${CN_NUM[page.skillIdx] ?? page.skillIdx + 1}门`}</span>
        </div>
      )}
      <style>{`@keyframes oc-breathe{0%,100%{opacity:.45}50%{opacity:1}}`}</style>
    </div>
  )
}

/** 章目录页（条目点击直达由外层 goView 承接——目录条目用按钮 + data-view 提示，这里渲染只读条目样式） */
function TOCPage({ chapter }: { chapter: (typeof CHAPTERS)[number] }) {
  const memberSkills = chapter.members
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '40px 40px 12px 48px', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <div className="serif" style={{ fontSize: 46, color: '#8B6F47', writingMode: 'vertical-rl', lineHeight: 1 }}>{chapter.no}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, letterSpacing: '.4em', color: '#6B5638', marginBottom: 6 }}>{chapter.en}</div>
          <div className="serif" style={{ fontSize: 25, letterSpacing: '.18em', color: '#3A2E1F', fontWeight: 600 }}>{chapter.emoji} {chapter.title}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#8B7D6B' }}>{chapter.desc}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
        {memberSkills.map((m, i) => (
          <div key={m} style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '11px 4px', borderBottom: '1px dashed rgba(139,111,71,.25)' }}>
            <span className="serif" style={{ color: '#8B6F47', fontSize: 12, width: '2.2em' }}>{CN_NUM[i] ?? i + 1}</span>
            <span className="serif" style={{ fontSize: 15, color: '#3A2E1F' }}>{m}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 技能秘籍页：三槽（施展/忌用/产出） */
function SkillPage({ skill, chapter, idx }: { skill: SkillEntry; chapter: (typeof CHAPTERS)[number]; idx: number }) {
  const p = parseSkillDescription(skill.desc)
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '36px 32px 12px 46px', minHeight: 0 }}>
      <div style={{ fontSize: 10, letterSpacing: '.35em', color: '#6B5638', marginBottom: 8 }}>{chapter.en} · 第{CN_NUM[idx] ?? idx + 1}门</div>
      <div className="serif" style={{ fontSize: 26, letterSpacing: '.1em', color: '#3A2E1F', fontWeight: 600 }}>{skill.name}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 10px' }}>
        <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg,transparent,rgba(139,111,71,.4),transparent)' }} />
        <span style={{ fontSize: 9, letterSpacing: '.4em', color: '#8B6F47' }}>秘 籍</span>
        <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg,transparent,rgba(139,111,71,.4),transparent)' }} />
      </div>
      {(p.when || p.notFor || p.output) ? (
        <div style={{ overflowY: 'auto' }}>
          {p.when && <Slot label="施展" text={p.when} />}
          {p.notFor && <Slot label="忌用" text={p.notFor} danger />}
          {p.output && <Slot label="产出" text={p.output} />}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#52402C', overflowY: 'auto' }}>{p.raw}</div>
      )}
    </div>
  )
}

function Slot({ label, text, danger }: { label: string; text: string; danger?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(139,111,71,.12)' }}>
      <span className="serif" style={{ flexShrink: 0, width: 46, textAlign: 'center', fontSize: 12.5, letterSpacing: '.2em', padding: '3px 0', borderRadius: 3, height: 'fit-content',
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
