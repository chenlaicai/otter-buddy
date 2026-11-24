import { useState } from 'react'
import { Check, Copy, Download, MonitorSmartphone, Plus, Terminal } from 'lucide-react'

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
  const [appDownloading, setAppDownloading] = useState(false)
  const [appDownloaded, setAppDownloaded] = useState(false)
  const [bootstrapDownloading, setBootstrapDownloading] = useState(false)
  const [bootstrapDownloaded, setBootstrapDownloaded] = useState(false)
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

  /** 同源登录态下载 blob 并触发保存（文件名由调用方定——包名带版本、引导文件固定名） */
  async function saveBlobDownload(res: Response, filename: string): Promise<void> {
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  async function downloadAppPackage() {
    if (appDownloading) return
    setAppDownloading(true)
    setAppDownloaded(false)
    setError(null)
    try {
      const res = await fetch('/api/connector/download/app', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(await responseError(res, '安装包下载失败'))
      const version = res.headers.get('X-Otter-Connector-Version')
      await saveBlobDownload(res, `otter-connector-${version ?? 'unknown'}.zip`)
      setAppDownloaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAppDownloading(false)
    }
  }

  async function downloadBootstrap() {
    if (!issued || bootstrapDownloading) return
    setBootstrapDownloading(true)
    setBootstrapDownloaded(false)
    setError(null)
    try {
      const res = await fetch('/api/connector/download/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code: issued.code }),
      })
      if (!res.ok) throw new Error(await responseError(res, '引导文件下载失败'))
      await saveBlobDownload(res, 'otter-connector-bootstrap.json')
      setBootstrapDownloaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBootstrapDownloading(false)
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
      await saveBlobDownload(res, `otter-buddy-connector-${version ?? 'unknown'}.tgz`)
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

      <div data-testid="app-package-section" className="space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-stone-700">
          <MonitorSmartphone size={13} className="text-otter-600" />macOS 安装包（双击启动）
        </div>
        <div className="rounded-lg bg-amber-400/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-700">
          开发态未签名：首次打开可能被 macOS 拦截，请右键选「打开」或在系统设置放行；内嵌 Node 运行时，目标电脑无需安装 Node/npm。终端向导式交互，不是 .app 图形界面。
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="download-connector-app"
            onClick={() => void downloadAppPackage()}
            disabled={appDownloading}
            className="px-2.5 py-1.5 text-[11px] rounded-lg glass-card text-stone-600 hover:bg-white/50 flex items-center gap-1.5 disabled:opacity-50"
          >
            <Download size={13} />{appDownloading ? '下载中…' : '下载安装包（zip）'}
          </button>
          {appDownloaded && <span className="text-[10px] text-teal-600 flex items-center gap-1"><Check size={12} />已下载</span>}
        </div>
        <p className="text-[10px] text-stone-400">
          步骤：下载 zip 并解压 → 双击 <code>OtterConnector.command</code> → 向导输入中枢地址与配对码（配对码可下载引导文件自动带入）→ 输入设备名完成配对并常驻。之后双击同一启动器即自动重连。
        </p>
        {issued && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="download-bootstrap"
              onClick={() => void downloadBootstrap()}
              disabled={bootstrapDownloading}
              className="px-2.5 py-1.5 text-[11px] rounded-lg glass-card text-stone-600 hover:bg-white/50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Download size={13} />{bootstrapDownloading ? '下载中…' : '下载引导文件（自动带入）'}
            </button>
            {bootstrapDownloaded && <span className="text-[10px] text-teal-600 flex items-center gap-1"><Check size={12} />已下载</span>}
          </div>
        )}
        {issued && (
          <p className="text-[10px] text-stone-400">
            引导文件 <code>otter-connector-bootstrap.json</code> 含当前配对码与中枢地址（与配对码同效、同样一次性）；保存到「下载」文件夹或启动器同目录即可被向导发现。
          </p>
        )}
      </div>

      <div className="border-t border-white/50 pt-3 space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-stone-700">
          <Terminal size={13} className="text-otter-600" />开发者方式：npm CLI tarball
        </div>
        <div className="rounded-lg bg-amber-400/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-700">
          开发态：需要 Node.js 22+、npm 和命令行；不是双击桌面应用。
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
      </div>

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
