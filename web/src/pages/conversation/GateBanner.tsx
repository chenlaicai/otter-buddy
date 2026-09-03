/**
 * 会话调度横幅（S3.5 / F20260903s35u，会议第四要素「闸门状态用户可见」）：
 * 闸门冻结期间在消息流顶部显示调度状态，解除后消失。
 *
 * 两种态（用户停机 > 限流冷却，flash 提案 B / 大獭裁决）：
 * - 🛑 已停机——用户按过中断，发新消息即恢复调度（显式意志，横幅必须给出恢复路径）
 * - ⏳ 限流冷却——模型限流熔断窗口内，显示截止时间（推导态，会自动恢复）
 *
 * 数据源 = /signal-trail 的 gate 字段（与轨迹同端点一次取全，随 2s 轮询自动刷新）。
 * 路由器未注入（降级直连链）时 gate=null，横幅不渲染。
 */

export interface GateState {
  halted: boolean
  rateLimitedUntil: string | null
}

/** gate 状态 → 横幅内容（纯函数，测试锁定文案与优先级） */
export function gateBannerMeta(gate: GateState | null | undefined): { icon: string; text: string; cls: string } | null {
  if (!gate) return null
  if (gate.halted) {
    return {
      icon: '🛑',
      text: '已停机——你按过中断，发新消息即恢复调度（排队中的信号已保留）',
      cls: 'bg-rose-50/90 text-rose-700 border-rose-200',
    }
  }
  if (gate.rateLimitedUntil) {
    const until = new Date(gate.rateLimitedUntil)
    const hhmm = Number.isFinite(until.getTime())
      ? until.toLocaleTimeString('sv-SE', { hour12: false, hour: '2-digit', minute: '2-digit' })
      : '稍后'
    return {
      icon: '⏳',
      text: `模型限流冷却中，至 ${hhmm} 自动恢复——新消息已排队，恢复后按序处理`,
      cls: 'bg-amber-50/90 text-amber-700 border-amber-200',
    }
  }
  return null
}

export function GateBanner({ gate }: { gate: GateState | null | undefined }) {
  const meta = gateBannerMeta(gate)
  if (!meta) return null
  return (
    <div
      data-testid="gate-banner"
      className={`mx-1 mt-1 flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs ${meta.cls}`}
      role="status"
    >
      <span>{meta.icon}</span>
      <span className="font-medium">{meta.text}</span>
    </div>
  )
}
