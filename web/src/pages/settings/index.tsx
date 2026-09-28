import { useState, useEffect } from 'react'
import { useBlocker } from 'react-router-dom'
import { OTTER_GRADIENT } from '../../lib/otter-colors'

import { showToast } from '../../components/Toast'
import * as api from '../../api/client'
import type { ModelInfoDTO } from '@contract/api'

export default function SettingsPage() {
  const [models, setModels] = useState<ModelInfoDTO[]>([])
  const [defaultAlias, setDefaultAlias] = useState('')
  const [savedAlias, setSavedAlias] = useState('')
  const [saving, setSaving] = useState(false)
  const [hasUnsaved, setHasUnsaved] = useState(false)
  const [userName, setUserName] = useState('')
  const [settingsInfo, setSettingsInfo] = useState<{ port: number; dbPath: string; embeddingModelPath: string; embeddingLocalModelPath?: string; embeddingDim: number; assistantWebEnabled?: boolean } | null>(null)
  // F20260924wast：浮动獭快捷键（可配置，localStorage 本地；⌘J/Ctrl+J 默认）
  const [hotkey, setHotkey] = useState(() => localStorage.getItem('floating-otter:hotkey') || 'j')
  const [glassT, setGlassT] = useState(() => {
    const v = parseFloat(localStorage.getItem('otter-glass-t') || '0.85')
    return isNaN(v) ? 0.85 : Math.min(1, Math.max(0.45, v))
  })

  function updateGlassT(v: number) {
    setGlassT(v)
    document.documentElement.style.setProperty('--glass-t', String(v))
    localStorage.setItem('otter-glass-t', String(v))
  }

  function updateHotkey(v: string) {
    const k = v.trim().toLowerCase().slice(0, 1)
    setHotkey(k)
    localStorage.setItem('floating-otter:hotkey', k || 'j')
  }

  useEffect(() => {
    api.getSettings()
      .then(s => {
        setModels(s.models)
        setDefaultAlias(s.defaultModelAlias)
        setSavedAlias(s.defaultModelAlias)
        setUserName(s.userName)
        setSettingsInfo({ port: s.port, dbPath: s.dbPath, embeddingModelPath: s.embeddingModelPath, embeddingLocalModelPath: s.embeddingLocalModelPath, embeddingDim: s.embeddingDim, assistantWebEnabled: s.assistantWebEnabled })
      })
      .catch(() => showToast('加载设置失败', 'error'))
  }, [])

  function markUnsaved() { setHasUnsaved(true) }

  async function saveSettings() {
    setSaving(true)
    try {
      const s = await api.updateSettings({ defaultModelAlias: defaultAlias, userName })
      setSavedAlias(s.defaultModelAlias)
      setDefaultAlias(s.defaultModelAlias)
      setUserName(s.userName)
      setHasUnsaved(false)
      showToast('设置已保存', 'success')
    } catch (err) {
      console.error('Failed to save settings:', err)
      showToast('保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  // S3 修复：SPA 路由级拦截——useBlocker 阻止客户端导航（点击 TopBar 链接等）
  // Why: beforeunload 只在浏览器关闭/刷新时触发，SPA 的 Link 导航不触发它
  useBlocker(({ currentLocation, nextLocation }) => {
    if (!hasUnsaved) return false // 无未保存变更，不阻止
    if (currentLocation.pathname === nextLocation.pathname) return false // 同路径不阻止
    // 确认框：用户可以选择离开或留下
    return !window.confirm('有未保存的变更，确定要离开吗？')
  })

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (hasUnsaved) { e.preventDefault(); e.returnValue = '有未保存的变更' }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsaved])

  return (
    <>
      <div className="flex flex-1 overflow-hidden p-3">
        <main className="flex-1 glass rounded-3xl overflow-y-auto p-8">
          <div className="max-w-[600px] mx-auto">
            <h1 className="text-lg font-semibold text-stone-700 mb-6">设置</h1>

            {/* Profile */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">身份</h2>
              <div>
                <label className="block text-xs font-medium text-stone-500 mb-1.5">你的名字</label>
                <input
                  type="text"
                  value={userName}
                  onChange={e => { setUserName(e.target.value); markUnsaved() }}
                  placeholder="海獭会用这个名字称呼你"
                  className="form-input w-full"
                  maxLength={32}
                />
                <p className="text-[11px] text-stone-400 mt-1">留空则使用默认称呼"搭档"；设置后海獭会在对话中用你的名字称呼你</p>
              </div>
            </section>

            {/* Appearance */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">外观</h2>
              <div>
                <label className="flex justify-between text-xs font-medium text-stone-500 mb-1.5">
                  <span>玻璃不透明度</span>
                  <span className="text-stone-400">{Math.round(glassT * 100)}%</span>
                </label>
                <input
                  type="range"
                  min={45}
                  max={100}
                  step={5}
                  value={Math.round(glassT * 100)}
                  onChange={e => updateGlassT(Number(e.target.value) / 100)}
                  className="glass-range w-full"
                />
                <p className="text-[11px] text-stone-400 mt-1">越低越透 · 即时生效 · 仅保存在本机浏览器</p>
              </div>
            </section>

            {/* F20260924wast：浮动獭 */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">浮动獭</h2>
              <div className="space-y-2">
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">浮动獭开关</span>
                  <span className="text-sm text-stone-400">
                    {settingsInfo?.assistantWebEnabled === false ? '已关闭' : '开启中'} (只读)
                  </span>
                </div>
                <p className="text-[11px] text-stone-400">
                  在 config.yaml 的 im.assistant.web.enabled 修改，重启进程生效。关闭后浮动獭不显示，web 助理对话仍在左侧栏「web 助理」分组可用。
                </p>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">唤起快捷键</label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-stone-400 px-2 py-1.5 bg-stone-100 rounded-lg">⌘ / Ctrl +</span>
                    <input
                      type="text"
                      value={hotkey}
                      onChange={e => updateHotkey(e.target.value)}
                      maxLength={1}
                      data-testid="settings-floating-hotkey"
                      className="form-input w-16 text-center uppercase"
                      placeholder="J"
                    />
                  </div>
                  <p className="text-[11px] text-stone-400 mt-1">仅保存在本机浏览器 · 刷新后生效 · 点击獭永远可用</p>
                </div>
              </div>
            </section>

            {/* LLM Models */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">模型</h2>
              <div className="mb-4">
                <label className="block text-xs font-medium text-stone-500 mb-1.5">默认模型</label>
                <select
                  value={defaultAlias}
                  onChange={e => { setDefaultAlias(e.target.value); markUnsaved() }}
                  className="form-input w-full"
                >
                  {models.map(m => (
                    <option key={m.alias} value={m.alias}>{m.alias}（{m.provider}/{m.model}）</option>
                  ))}
                </select>
                <p className="text-[11px] text-stone-400 mt-1">切换后仅影响新会话；模型与 API Key 在 config.yaml 的 llm.models[] 中维护</p>
              </div>
              <div className="space-y-2">
                {models.map(m => (
                  <div key={m.alias} className="py-2 border-b border-white/30">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-stone-600 font-medium">
                        {m.alias}
                        {m.alias === savedAlias && (
                          <span className="ml-2 text-[10px] text-teal-500 border border-teal-400/50 rounded px-1 py-0.5">默认</span>
                        )}
                      </span>
                      <span className="text-xs text-stone-400">{m.provider}/{m.model}</span>
                    </div>
                    {m.description && <p className="text-xs text-stone-400 mt-0.5">{m.description}</p>}
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(m.strengths ?? []).map(s => (
                        <span key={s} className="text-[10px] text-teal-600 bg-teal-400/10 rounded px-1 py-0.5">{s}</span>
                      ))}
                      {(m.weaknesses ?? []).map(w => (
                        <span key={w} className="text-[10px] text-amber-600 bg-amber-400/10 rounded px-1 py-0.5">{w}</span>
                      ))}
                      {m.contextWindow && (
                        <span className="text-[10px] text-stone-400 bg-stone-400/10 rounded px-1 py-0.5">ctx {Math.round(m.contextWindow / 1000)}k</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* System Params */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">系统参数</h2>
              <div className="space-y-2">
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">服务端口</span>
                  <span className="text-sm text-stone-400">{settingsInfo?.port ?? '...'} (只读)</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">数据库路径</span>
                  <span className="text-sm text-stone-400">{settingsInfo?.dbPath ?? '...'} (只读)</span>
                </div>
              </div>
            </section>

            {/* Embedding Status */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">Embedding 状态</h2>
              <div className="space-y-2">
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">模型</span>
                  <span className="text-sm text-stone-400">{settingsInfo?.embeddingModelPath ?? '...'}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">加载模式</span>
                  <span className="text-sm text-stone-400">
                    {settingsInfo?.embeddingLocalModelPath
                      ? `本地（${settingsInfo.embeddingLocalModelPath}）`
                      : '远程（HuggingFace）'}
                  </span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">维度</span>
                  <span className="text-sm text-stone-400">{settingsInfo?.embeddingDim ?? '...'}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">加载状态</span>
                  <span className="text-sm text-teal-500">✓ 已加载</span>
                </div>
              </div>
            </section>

            {/* Save Bar */}
            <div className="flex items-center justify-between pt-4 border-t border-white/40">
              {hasUnsaved ? (
                <span className="text-sm text-amber-500 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  有未保存的变更
                </span>
              ) : (
                <span />
              )}
              <button
                onClick={saveSettings}
                disabled={saving}
                className="px-6 py-2 text-sm text-white rounded-xl shadow-glow transition disabled:opacity-50"
                style={{
                  background: OTTER_GRADIENT,
                  boxShadow: hasUnsaved ? '0 0 0 2px rgba(245,158,11,0.4)' : undefined,
                }}
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </main>
      </div>
    </>
  )
}
