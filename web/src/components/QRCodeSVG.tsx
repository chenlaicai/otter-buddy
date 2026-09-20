import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/**
 * F20260920imax：二维码组件（qrcode 库，零手写算法）。
 *
 * 用途：IM 页飞书卡渲染 appShareUrl（applink 分享链）二维码——
 * 扫码直达飞书机器人会话（已添加则打开对话，未添加则展示添加卡片）。
 *
 * Why 库而非自绘：QR 编码涉及 Reed-Solomon/掩码评价等底层算法，手写
 * 验证成本远超收益（实测自绘版 jsQR 解码失败后放弃）。qrcode 是纯 JS
 * 零依赖库，toDataURL 输出 PNG data URL，浏览器直渲。
 */
export function QRCodeSVG({ value, size = 140 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    QRCode.toDataURL(value, { width: size * 2, margin: 2, errorCorrectionLevel: 'M' })
      .then((url) => { if (alive) setDataUrl(url) })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)) })
    return () => { alive = false }
  }, [value, size])

  if (error) {
    return (
      <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #ccc', borderRadius: 8, fontSize: 11, color: '#999', padding: 8, textAlign: 'center' }}>
        二维码生成失败：{error}
      </div>
    )
  }
  if (!dataUrl) {
    return <div style={{ width: size, height: size, borderRadius: 8, background: '#f5f5f4' }} />
  }
  return <img src={dataUrl} width={size} height={size} alt="二维码" style={{ borderRadius: 8, display: 'block' }} />
}
