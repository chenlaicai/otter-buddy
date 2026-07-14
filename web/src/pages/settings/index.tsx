import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles/globals.css'

import { AppLayout } from '../../components/AppLayout'
import { showToast } from '../../components/Toast'

// TODO: API contract not yet defined - all data is mocked

const modelsByProvider: Record<string, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
  google: ['gemini-2.0-flash', 'gemini-2.5-pro'],
}

function SettingsPage() {
  const [provider, setProvider] = useState('openai')
  const [model, setModel] = useState('gpt-4o')
  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [halfLife, setHalfLife] = useState('7')
  const [saving, setSaving] = useState(false)
  const [hasUnsaved, setHasUnsaved] = useState(false)

  function markUnsaved() {
    setHasUnsaved(true)
  }

  function updateModels(p: string) {
    setProvider(p)
    setModel(modelsByProvider[p]?.[0] || '')
    markUnsaved()
  }

  function testConnection() {
    setTesting(true)
    setTestResult(null)
    setTimeout(() => {
      setTesting(false)
      if (apiKey && apiKey.length > 5) {
        setTestResult({ ok: true, msg: '✓ 连接成功' })
      } else {
        setTestResult({ ok: false, msg: '✗ 连接失败：API Key 无效' })
      }
    }, 1200)
  }

  function saveSettings() {
    setSaving(true)
    setTimeout(() => {
      setSaving(false)
      setHasUnsaved(false)
      showToast('设置已保存', 'success')
    }, 800)
  }

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (hasUnsaved) {
        e.preventDefault()
        e.returnValue = '有未保存的变更'
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsaved])

  return (
    <AppLayout activeView="settings">
      <div className="flex flex-1 overflow-hidden p-3">
        <main className="flex-1 glass rounded-3xl overflow-y-auto p-8">
          <div className="max-w-[600px] mx-auto">
            <h1 className="text-lg font-semibold text-stone-700 mb-6">设置</h1>

            {/* LLM Config */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">LLM 配置</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">Provider</label>
                  <select value={provider} onChange={e => updateModels(e.target.value)} className="form-input w-full">
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">Model</label>
                  <select value={model} onChange={e => { setModel(e.target.value); markUnsaved() }} className="form-input w-full">
                    {(modelsByProvider[provider] || []).map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">API Key</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={e => { setApiKey(e.target.value); markUnsaved() }}
                    className="form-input w-full"
                    placeholder="sk-..."
                  />
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={testConnection}
                    disabled={testing}
                    className="px-4 py-2 text-sm glass-card text-stone-600 rounded-xl hover:bg-white/50 transition disabled:opacity-50"
                  >
                    {testing ? '测试中...' : '测试连接'}
                  </button>
                  {testResult && (
                    <span className={`text-sm ${testResult.ok ? 'text-teal-500' : 'text-red-400'}`}>
                      {testResult.msg}
                    </span>
                  )}
                </div>
              </div>
            </section>

            {/* System Params */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">系统参数</h2>
              <div className="space-y-2">
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">服务端口</span>
                  <span className="text-sm text-stone-400">3000 (只读)</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">数据库路径</span>
                  <span className="text-sm text-stone-400">./otter-buddy.db (只读)</span>
                </div>
              </div>
            </section>

            {/* Memory Params */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">记忆参数</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1.5">时间衰减半衰期 (天)</label>
                  <input
                    type="number"
                    value={halfLife}
                    onChange={e => { setHalfLife(e.target.value); markUnsaved() }}
                    className="form-input w-full"
                  />
                </div>
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">权重系数</span>
                  <span className="text-xs text-stone-400">time_decay × frequency × task_relevance × user_flag (只读)</span>
                </div>
              </div>
            </section>

            {/* Embedding Status */}
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-stone-600 mb-4">Embedding 状态</h2>
              <div className="space-y-2">
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">模型</span>
                  <span className="text-sm text-stone-400">Xenova/bge-m3</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-white/30">
                  <span className="text-sm text-stone-500">维度</span>
                  <span className="text-sm text-stone-400">1024</span>
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
                  background: 'linear-gradient(135deg,#A88260,#6B5638)',
                  boxShadow: hasUnsaved ? '0 0 0 2px rgba(245,158,11,0.4)' : undefined,
                }}
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </main>
      </div>
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<SettingsPage />)
