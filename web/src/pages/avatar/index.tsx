import { useCallback, useEffect, useState } from 'react'
import { MoveHorizontal, RotateCcw } from 'lucide-react'
import { OtterScene } from './OtterScene'
import type { AvatarGesture } from './avatar-motion'
import './avatar.css'

export default function AvatarPage() {
  const [ready, setReady] = useState(false)
  const [gesture, setGesture] = useState<AvatarGesture>(null)
  const [gestureKey, setGestureKey] = useState(0)
  const [mood, setMood] = useState<'idle' | 'curious'>('idle')
  const [reducedMotion, setReducedMotion] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  const onReady = useCallback(() => setReady(true), [])

  useEffect(() => {
    // Why: 这个独立预览页必须在手机上可用；离开即恢复桌面工作台约束。
    document.body.classList.add('avatar-page-active')
    return () => document.body.classList.remove('avatar-page-active')
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  function play(next: Exclude<AvatarGesture, null>) {
    setGesture(next)
    setGestureKey(key => key + 1)
  }

  return (
    <main className="avatar-page">
      <div className="avatar-layout">
        <section className="avatar-intro" aria-labelledby="avatar-title">
          <p className="avatar-eyebrow">OTTER, IN ANOTHER DIMENSION</p>
          <h1 id="avatar-title">你好，<br />我立体了。</h1>
          <p className="avatar-description">还是那只系着红围巾的大獭。<br />现在，可以转过头来看看你。</p>
          <div className="avatar-signature">
            <span className="avatar-signature-mark" aria-hidden="true" />
            <span>雾蓝软陶 · 新造型</span>
          </div>
        </section>

        <section className="avatar-stage" aria-label="3D 头像预览">
          <div className="avatar-halo" aria-hidden="true" />
          <OtterScene key={resetKey} gesture={gesture} gestureKey={gestureKey} mood={mood} reducedMotion={reducedMotion} onReady={onReady} />
          <p className="avatar-drag-hint"><MoveHorizontal size={16} />拖动，让我转个身</p>
        </section>

        <section className="avatar-controls" aria-label="头像动作">
          <div className="avatar-control-heading">
            <span>给我打个招呼</span>
            <span className="avatar-live"><i />LIVE</span>
          </div>
          <div className="avatar-actions">
            <button onClick={() => play('hello')} disabled={!ready}>挥挥爪 <span aria-hidden="true">↗</span></button>
            <button onClick={() => play('nod')} disabled={!ready}>点点头 <span aria-hidden="true">↓</span></button>
            <button onClick={() => play('blink')} disabled={!ready}>眨眨眼 <span aria-hidden="true">◡</span></button>
          </div>
          <div className="avatar-mood-row">
            <span>神态</span>
            <div className="avatar-segmented" aria-label="选择神态">
              <button aria-pressed={mood === 'idle'} onClick={() => setMood('idle')}>自在</button>
              <button aria-pressed={mood === 'curious'} onClick={() => setMood('curious')}>好奇</button>
            </div>
          </div>
          <button className="avatar-reset" onClick={() => { setMood('idle'); setGesture(null); setGestureKey(0); setResetKey(key => key + 1) }}>
            <RotateCcw size={13} />回到自在
          </button>
        </section>
      </div>
      <footer className="avatar-footer">
        <span>从熟悉的头像开始，长出一个新的我。</span>
        <span>EXPERIMENT 001</span>
      </footer>
    </main>
  )
}
