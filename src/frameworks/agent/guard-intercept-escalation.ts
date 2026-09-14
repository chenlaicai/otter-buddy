/**
 * #844（F20260914dsrv）方案 C：guard_intercept 重复拦截升级判定（纯函数）。
 *
 * 背景：#844 现场同一獭 6h 内 6 次变体重试全被拦、全部 medium 静默落账——
 * 「正当诉求无出路」的信号被淹没。升级规则：同 otter 近 ESCALATION_WINDOW_MS 内
 * guard_intercept 累计 ≥ ESCALATION_THRESHOLD 次 → severity 升 high +
 * suggestion 换人工排查文案（落账侧消费本函数结果）。
 */

/** 升级观察窗（毫秒）——6 小时，对齐 #844 现场的时间跨度 */
export const ESCALATION_WINDOW_MS = 6 * 60 * 60 * 1000;
/** 窗口内累计拦截次数阈值（含本次；即第 3 次拦截起升级） */
export const ESCALATION_THRESHOLD = 3;

export interface InterceptLikeEvent {
  createdAt?: string;
}

export interface GuardInterceptClassification {
  /** true = 本次拦截应升级 high */
  repeated: boolean;
  /** 窗口内已有拦截次数（不含本次） */
  priorCount: number;
}

/**
 * 判定本次拦截的落账等级。recentEvents 为该 otter 最近的 guard_intercept 事件
 * （created_at 倒序，条数不限——本函数自行过滤窗口）。解析失败的时间戳条目忽略。
 */
export function classifyGuardIntercept(
  recentEvents: readonly InterceptLikeEvent[],
  now: number = Date.now(),
): GuardInterceptClassification {
  const priorCount = recentEvents.filter(e => {
    const t = Date.parse(e.createdAt ?? "");
    return Number.isFinite(t) && now - t >= 0 && now - t < ESCALATION_WINDOW_MS;
  }).length;
  return { repeated: priorCount + 1 >= ESCALATION_THRESHOLD, priorCount };
}
