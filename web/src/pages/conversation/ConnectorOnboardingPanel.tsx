import { useState } from 'react'
import { Check, Copy, Download, Plus, Terminal } from 'lucide-react'

interface IssuedCode {
  code: string
  expiresAt: string
}

async function responseError(res: Response, fallback: string): Promise<string> {
  if (res.status === 401) return '登录已过期，请刷新页面重新登录（HTTP 401）'
  if (res.status === 403) return '当前身份无权执行此操作：签发配对码需要 owner/admin（HTTP 403）'
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `${fallback}（HTTP ${String(res.status)}）`
}

/** 一次性秘密只留在组件内存；关闭执行机弹窗即卸载，不写存储或日志。 */
export function ConnectorOnboardingPanel() {
  const [issued, setIssued] = useState<IssuedCode | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hubUrl = window.location.origin
  const command = issued
    ? `otter-connector --hub ${hubUrl} --pair ${issued.code} --name "我的电脑"`
    : ''

  async function issueCode() {
    if (issuing) return
    setIssuing(true)
    setIssued(null)
    setCopied(false)
    setError(null)
    try {
      const res = await fetch('/api/connector/pairing-codes', {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error(await responseError(res, '配对码签发失败'))
      setIssued(await res.json() as IssuedCode)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIssuing(false)
    }
  }

  async function downloadPackage() {
    if (downloading) return
    setDownloading(true)
    setDownloaded(false)
    setError(null)
    try {
      const res = await fetch('/api/connector/download', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(await responseError(res, 'CLI 安装包下载失败'))
      const version = res.headers.get('X-Otter-Connector-Version')
      const url = URL.createObjectURL(await res.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `otter-buddy-connector-${version ?? 'unknown'}.tgz`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setDownloaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
    }
  }

  async function copyCommand() {
    if (!command) return
    setError(null)
    try {
      if (!navigator.clipboard) throw new Error('当前浏览器不支持自动复制，请手动选择命令')
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch (err) {
      setCopied(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section data-testid="connector-onboarding" className="rounded-xl border border-otter-400/20 bg-otter-400/5 p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-stone-700 flex items-center gap-1.5">
            <Plus size={14} className="text-otter-600" />添加设备
          </h3>
          <p className="text-[10px] text-stone-400 mt-1">从当前中枢签发一次性配对码，让新电脑主动连接。</p>
        </div>
        <button
          type="button"
          onClick={() => void issueCode()}
          disabled={issuing}
          className="shrink-0 px-2.5 py-1.5 text-[11px] font-medium text-white rounded-lg shadow-glow bg-otter-500 hover:bg-otter-600 disabled:opacity-50"
        >
          {issuing ? '签发中…' : issued ? '生成新码' : '生成配对码'}
        </button>
      </div>

      <div className="rounded-lg bg-amber-400/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-700">
        开发态：下载的是 npm CLI tarball，需要 Node.js 20+、npm 和命令行；不是双击桌面应用。
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="download-connector"
          onClick={() => void downloadPackage()}
          disabled={downloading}
          className="px-2.5 py-1.5 text-[11px] rounded-lg glass-card text-stone-600 hover:bg-white/50 flex items-center gap-1.5 disabled:opacity-50"
        >
          <Download size={13} />{downloading ? '下载中…' : '下载 CLI 安装包'}
        </button>
        {downloaded && <span className="text-[10px] text-teal-600 flex items-center gap-1"><Check size={12} />已下载</span>}
      </div>
      <p className="text-[10px] text-stone-400">安装：在下载目录执行 <code>npm install -g &lt;下载的.tgz&gt;</code></p>

      {issued && (
        <div className="space-y-2 border-t border-white/50 pt-3" data-testid="pairing-details">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="text-[10px] text-stone-400">一次性配对码</div>
              <div data-testid="pairing-code" className="font-mono text-xl font-semibold tracking-[0.18em] text-otter-700">{issued.code}</div>
            </div>
            <div className="text-right text-[10px] text-stone-400">
              <div>10 分钟内单次有效</div>
              <div>至 {new Date(issued.expiresAt).toLocaleString()}</div>
            </div>
          </div>
          <div className="text-[10px] text-stone-500">
            当前中枢：<code data-testid="hub-url" className="break-all">{hubUrl}</code>
          </div>
          <div className="rounded-lg bg-stone-800 text-stone-100 px-2.5 py-2">
            <div className="text-[9px] text-stone-400 mb-1 flex items-center gap-1"><Terminal size={11} />安装后运行</div>
            <code data-testid="pairing-command" className="block text-[10px] break-all leading-relaxed">{command}</code>
          </div>
          <button
            type="button"
            onClick={() => void copyCommand()}
            className="text-[10px] text-stone-500 hover:text-stone-700 flex items-center gap-1"
          >
            {copied ? <Check size={12} className="text-teal-500" /> : <Copy size={12} />}
            {copied ? '已复制首启命令' : '复制首启命令'}
          </button>
          <p className="text-[10px] text-stone-400">此前已生成但未核销的码在各自到期前仍可使用；每码只能核销一次。</p>
          <p className="text-[10px] text-stone-400">配对码只在此处显示；请只交给你要添加的设备。设备上线后可关闭弹窗。</p>
        </div>
      )}

      {error && <div role="alert" className="text-[11px] text-red-500 bg-red-400/10 rounded-lg px-2.5 py-2">{error}</div>}
    </section>
  )
}
