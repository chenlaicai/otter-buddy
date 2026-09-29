/**
 * 信号裁决提醒登记表（#1227，M1：当场处理可见性保证）。
 *
 * 同构 healing-alert-registry（F20260826mwrd C3）模式：
 * - 小獭 speak 嵌 <signal> 落账时（interceptSignalReport）在此登记
 * - 大獭下一次 invoke 的 buildDynamicContext 消费（DynamicContext.signalAlerts）
 *   ——送达时点由「下一个 invoke 边界」保证，无需轮询
 * - 大獭 resolve_signal 裁决后注销（信号 ID 粒度）——提醒与台账状态联动
 * - 大獭不在本对话（跨对话 invoke 是常态）：提醒按信号归属对话滞留，
 *   大獭在该对话的下一轮才看到——接受（aging worker 24h 兜底告警仍在）
 *
 * 内存态而非落库：这是「未送达的提醒」队列，送达即删；signal_events 主台账
 * 仍是持久化真相源。进程重启丢队列的代价 = 错过一次提醒，台账完整 + aging
 * 兜底——接受（与 healing-alert-registry 同口径）。
 *
 * 键为 conversationId：intercept 时不知谁是大獭，消费侧（agent-invoker）解析。
 * 进程级单例（同 haltRegistry / healingAlertRegistry 模式）。
 */

/** 一条待提醒的 pending 信号 */
export interface SignalAlert {
  /** signal_events 落账 id（前 8 位短 ID 即裁决可用） */
  signalId: string;
  conversationId: string;
  fromOtterId: string;
  signalType: string;
  severity: string;
  payloadPreview: string;
  createdAt: string;
}

class SignalAlertRegistry {
  /** 对话 → 待提醒队列 */
  private pending = new Map<string, SignalAlert[]>();
  /** 单对话积压上限（防滥用；台账里仍有全量） */
  private static readonly MAX_PENDING_PER_CONVERSATION = 20;

  /** 信号落账时登记（fire-and-forget：登记失败不阻断发言） */
  register(alert: SignalAlert): void {
    const q = this.pending.get(alert.conversationId) ?? [];
    q.push(alert);
    if (q.length > SignalAlertRegistry.MAX_PENDING_PER_CONVERSATION) {
      q.splice(0, q.length - SignalAlertRegistry.MAX_PENDING_PER_CONVERSATION);
    }
    this.pending.set(alert.conversationId, q);
  }

  /** 大獭消费：取走该对话全部待提醒（送达即删——注入面是借用式，下一轮不再重复） */
  takeAll(conversationId: string): SignalAlert[] {
    const q = this.pending.get(conversationId);
    if (!q || q.length === 0) return [];
    this.pending.delete(conversationId);
    return q;
  }

  /** 裁决后注销（信号 ID 粒度——resolve_signal 成功时调用，防已裁决信号继续提醒） */
  dismiss(signalId: string): void {
    for (const [convId, q] of this.pending) {
      const idx = q.findIndex(a => a.signalId === signalId);
      if (idx >= 0) {
        q.splice(idx, 1);
        if (q.length === 0) this.pending.delete(convId);
        return;
      }
    }
  }

  /** 测试重置 */
  resetForTest(): void {
    this.pending.clear();
  }
}

export const signalAlertRegistry = new SignalAlertRegistry();

/** #1227 M1：pending 信号裁决提醒渲染——大獭 invoke 头部注入文案（借用式，消费即删） */
export function renderSignalAlerts(alerts: SignalAlert[]): string {
  const lines = alerts.map(a =>
    `- ${a.signalId.slice(0, 8)}（${a.signalType}/${a.severity}，from ${a.fromOtterId.slice(0, 8)}）：${a.payloadPreview}`,
  );
  return [
    `## ⚖️ 裁决义务提醒（${alerts.length} 条 pending 信号）`,
    '',
    '本对话有未裁决的獭间信号（协议：收到 objection/blocked 后必须显式裁决，不得悬置）：',
    ...lines,
    '',
    '处置：调 resolve_signal(signalId=上述短 ID, status=resolved|dismissed, resolution=理由)。裁决完本提醒自动消解；悬置超 24h aging 会再次告警。',
  ].join('\n');
}
