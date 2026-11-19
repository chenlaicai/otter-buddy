/**
 * P2b1：夜间审视治量结构（otter-memory-design v4）。
 *
 * 「治量结构 > 内容」——夜间审视调度器（P2b2）的幂等与失败治理档案点。
 * 解决的问题：夜审是 LLM 会话，重跑两次产出必不同（非确定性），必须有存档点判重；
 * 崩溃/停机重跑必须「不丢不重」，从旧水位继续。
 *
 * 关键语义：
 * - 幂等键 review:{date}:{taskId}——同一 (审视日, 任务) 只允许一份成功变更集；
 *   撞键直接返回上次 result（resultJson 非空 = 已 settle）。
 * - failed_range = [after, through]（区间不是点）——连败计数绑定这个区间；
 *   重跑只重做这个区间，换区间则计数清零。
 *
 * 本实体只做形态定义与纯函数；写入/迁移判断在 usecase（manage-consolidation-state.ts）。
 */

/** 同区间连败阈值：达到后跳过该区间 + 报 healing（P2b2 编排侧消费） */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 合法时间点：ISO 8601 UTC（YYYY-MM-DDTHH:mm:ss(.sss)Z）。
 * 重现路径：memory_entries.createdAt 由 new Date().toISOString() 产出（store-memory.ts:78），
 * 失败区间 after/through 取自已落库的 createdAt 边界，必须与之一致；
 * SQLite datetime('now') 默认格式（空格分隔无 Z）不出现在秩序比较中。
 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export function isValidInstant(s: string): boolean {
  return typeof s === "string" && ISO_INSTANT_RE.test(s);
}

/** 失败区间形态合法：两端都是 ISO instant 且 after <= through（数值序，不用于字符串序——同刻异精度如“00Z”vs“00.000Z”不会被误判倒挂）。 */
export function isOrderedFailureRange(after: string, through: string): boolean {
  if (!isValidInstant(after) || !isValidInstant(through)) return false;
  return Date.parse(after) <= Date.parse(through);
}

/** 幂等键前缀 */
const IDEMPOTENCY_PREFIX = "review";

/** 审视日格式：YYYY-MM-DD（Asia/Shanghai 墙钟日） */
export function isValidReviewDate(s: string): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * 构造审视幂等键：review:{date}:{taskId}。
 * date 与 taskId 均非空且 date 为 YYYY-MM-DD 才合法，否则抛出（fail-closed，
 * 防空 taskId 让不同任务撞上同一份「原结果」）。
 */
export function buildReviewKey(date: string, taskId: string): string {
  if (!isValidReviewDate(date)) {
    throw new Error(`invalid consolidation review date: ${JSON.stringify(date)}`);
  }
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("consolidation review taskId must be non-empty");
  }
  return `${IDEMPOTENCY_PREFIX}:${date}:${taskId}`;
}

/** 从幂等键回解 { date, taskId }。非法键返回 null（键由 buildReviewKey 产出，default 不会非法）。 */
export function parseReviewKey(key: string): { date: string; taskId: string } | null {
  if (typeof key !== "string") return null;
  const parts = key.split(":");
  if (parts.length < 3 || parts[0] !== IDEMPOTENCY_PREFIX) return null;
  const date = parts[1];
  const taskId = parts.slice(2).join(":");
  if (!isValidReviewDate(date) || taskId.length === 0) return null;
  return { date, taskId };
}

/** 夜间审视治量状态（consolidation_state 表行） */
export interface ConsolidationState {
  /** 幂等键 review:{date}:{taskId} */
  reviewKey: string;
  /** 失败区间起点（ISO）。null = 当前无在途失败区间 */
  failedAfter: string | null;
  /** 失败区间终点（ISO）。null = 当前无在途失败区间 */
  failedThrough: string | null;
  /** 同区间（failedAfter..failedThrough 不变）连败次数 */
  failures: number;
  /** 上次成功变更集（JSON 序列化）。非空 = 已 settle（幂等撞键直接返回它） */
  resultJson: string | null;
  /** 最近一次写入时间（ISO） */
  updatedAt: string;
}

/** 新建空白状态行（failures=0、无失败区间、无结果） */
export function newConsolidationState(reviewKey: string, nowIso: string): ConsolidationState {
  return {
    reviewKey,
    failedAfter: null,
    failedThrough: null,
    failures: 0,
    resultJson: null,
    updatedAt: nowIso,
  };
}