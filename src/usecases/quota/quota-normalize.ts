/**
 * F20261012qtbc：三家配额响应归一化——领域纯函数（无 IO，可单测）。
 *
 * 归一化 fail-closed：响应结构识别不出返回 null，由服务层报 error——
 * 猜错的「准确数字」比没有更糟（搭档要的是准确值）。
 *
 * 字段依据（2026-10-12 静态逆向前端 bundle，见特性文档「接口探查证据」）：
 *  - GLM：limits[] 项 title/name、currentValue、showLimitCount、nextResetTime（chunk module a279）
 *  - MiMo：currentPlanUsage / currentPlanRemainingValue 等（main chunk 字段线索）
 *  - Kimi：字段未定名（/apiv2 connect-RPC），启发式 + 首登冒烟后锁定
 */
import type { QuotaWindow } from "./quota-types";

/* ---------- 通用小工具（纯函数） ---------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstNumber(rec: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function firstString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/** 重置时间解析：ISO 字符串 / 'YYYY-MM-DD HH:mm:ss'（GLM 报错文案同款格式）/ 秒或毫秒时间戳 */
export function parseResetAt(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? raw.trim().replace(" ", "T") : raw.trim();
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** 由展示名推稳定键：'5 小时'→5h、'本周/每周'→week、'本月'→month；其余按序号兜底 */
export function keyFromLabel(label: string, index: number): string {
  if (/[5５]/.test(label) && /(时|hour|hr)/i.test(label)) return "5h";
  if (/(周|week|7\s*日|七日)/i.test(label)) return "week";
  if (/(月|month)/i.test(label)) return "month";
  if (/(总|全部|total|all)/i.test(label)) return "total";
  return `w${index}`;
}

/** 启发式 key → 展示名（Kimi RPC 字段名兜底展示） */
function humanizeKey(key: string): string {
  const k = key.toLowerCase();
  if (/(five.?hour|hourly|hour|5h)/.test(k)) return "5 小时";
  if (/(seven|week)/.test(k)) return "7 日";
  if (/(month)/.test(k)) return "本月";
  if (/(total|all)/.test(k)) return "总量";
  return key;
}

export interface WindowValues {
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
}

/** limit 缺失但 used+remaining 已知时，套餐总量 = used + remaining（MiMo 单余量形态） */
function deriveLimit(used: number | null, remaining: number | null, limit: number | null): number | null {
  if (limit !== null) return limit;
  return used !== null && remaining !== null ? used + remaining : null;
}

/** remaining 缺失但 used+limit 已知时取差值 */
function deriveRemaining(used: number | null, remaining: number | null, limit: number | null): number | null {
  if (remaining !== null) return remaining;
  return used !== null && limit !== null ? Math.max(limit - used, 0) : null;
}

function deriveRatio(remaining: number | null, limit: number | null): number | null {
  if (remaining === null || limit === null || limit <= 0) return null;
  return Math.min(Math.max(remaining / limit, 0), 1);
}

/** 组装窗口：补齐 limit / remaining / remainingRatio（推导规则见各 derive 小函数） */
export function buildWindow(label: string, values: WindowValues, index = 0): QuotaWindow {
  const used = values.used ?? null;
  const limit = deriveLimit(used, values.remaining ?? null, values.limit ?? null);
  const remaining = deriveRemaining(used, values.remaining ?? null, limit);
  return {
    key: keyFromLabel(label, index),
    label,
    used,
    limit,
    remaining,
    remainingRatio: deriveRatio(remaining, limit),
    resetAt: values.resetAt ?? null,
  };
}

/** BFS 遍历收集对象节点（含数组元素），限深防爆 */
function collectObjects(root: unknown, maxNodes = 200): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const queue: unknown[] = [root];
  while (queue.length > 0 && out.length < maxNodes) {
    const cur = queue.shift();
    if (Array.isArray(cur)) {
      queue.push(...cur.slice(0, 50));
    } else if (isRecord(cur)) {
      out.push(cur);
      queue.push(...Object.values(cur).slice(0, 50));
    }
  }
  return out;
}

/* ---------- S2 加固（对抗审视 2026-10-12）：防「自信猜数」 ---------- */

/** 时序数据点黑名单键：命中则该对象是日/时粒度统计点，不是窗口——跳过 */
const TIME_SERIES_KEYS = new Set(["date", "day", "timestamp", "statDate", "dateStr", "statTime"]);

function looksLikeTimeSeriesPoint(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some(k => TIME_SERIES_KEYS.has(k));
}

/** 启发式命中必须至少两个数字（used/limit/remaining 中 ≥2），单字段不成立窗 */
function hasEnoughNumbers(used: number | null, limit: number | null, remaining: number | null): boolean {
  return [used, limit, remaining].filter(v => v !== null).length >= 2;
}

/* ---------- GLM：/monitor/usage/quota/limit ---------- */

export function normalizeGlm(payload: unknown): QuotaWindow[] | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload.data) ? payload.data : payload;
  const limits = data.limits;
  if (!Array.isArray(limits) || limits.length === 0) return null;
  const windows: QuotaWindow[] = [];
  limits.forEach((item, i) => {
    if (!isRecord(item)) return;
    const label = firstString(item, ["title", "name", "label"]) ?? `限额 ${i + 1}`;
    const used = firstNumber(item, ["currentValue", "used", "usage"]);
    const limit = firstNumber(item, ["showLimitCount", "limit", "total", "totalCount"]);
    const resetAt = parseResetAt(item.nextResetTime ?? item.resetTime ?? item.reset_time);
    if (used === null && limit === null) return;
    windows.push(buildWindow(label, { used, limit, resetAt }, i));
  });
  return windows.length > 0 ? windows : null;
}

/* ---------- MiMo：/api/v1/tokenPlan/* ---------- */

export function normalizeMimo(payload: unknown): QuotaWindow[] | null {
  // 字段依据静态分析（currentPlanRemainingValue/currentPlanUsage），首登冒烟后锁定。
  // S2 加固：要求 currentPlan* 签名字段才认——通用 used/remaining 字段的对象一律不猜。
  for (const obj of collectObjects(payload)) {
    if (looksLikeTimeSeriesPoint(obj)) continue; // S2 加固：日/时粒度统计点不是窗口
    const hasSignature = Object.keys(obj).some(k => k.startsWith("currentPlan"));
    if (!hasSignature) continue;
    const used = firstNumber(obj, ["currentPlanUsage", "used", "usage", "usedValue", "consumed"]);
    const remaining = firstNumber(obj, ["currentPlanRemainingValue", "remaining", "remain", "left", "surplus"]);
    const limit = firstNumber(obj, ["currentPlanLimit", "limit", "total", "totalValue", "quota"]);
    if (used === null && remaining === null) continue;
    const label = firstString(obj, ["title", "name", "label"]) ?? "总量";
    return [buildWindow(label, { used, limit, remaining }, 0)];
  }
  return null;
}

/* ---------- Kimi：/apiv2 connect-RPC（字段未定名，启发式 + 首登锁定） ---------- */

/** S2 加固：窗口名严格白名单（归一化后精确匹配），杜绝 timestamp_hour 之类的通用词误命中 */
const KIMI_WINDOW_KEY = /^(fivehour(s)?|5h|hourly|week|weekly|sevendays?|7d|month|monthly|total)$/;

export function normalizeKimi(payload: unknown): QuotaWindow[] | null {
  const windows: QuotaWindow[] = [];
  for (const obj of collectObjects(payload)) {
    if (looksLikeTimeSeriesPoint(obj)) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (!isRecord(value)) continue;
      if (!KIMI_WINDOW_KEY.test(key.replace(/[_-]/g, "").toLowerCase())) continue;
      const used = firstNumber(value, ["used", "usage", "usedValue", "consumed", "currentValue"]);
      const limit = firstNumber(value, ["limit", "total", "totalValue", "quota", "showLimitCount"]);
      const remaining = firstNumber(value, ["remaining", "remain", "left"]);
      const resetAt = parseResetAt(value.resetAt ?? value.resetTime ?? value.reset_time ?? value.nextResetTime);
      // S2 加固：至少两个数字才成窗（防单字段对象借窗口名蒙混）
      if (!hasEnoughNumbers(used, limit, remaining)) continue;
      windows.push(buildWindow(humanizeKey(key), { used, limit, remaining, resetAt }, windows.length));
    }
  }
  if (windows.length === 0) return null;
  // 同 key 去重（BFS 可能命中同一结构的嵌套拷贝），保留首个
  const seen = new Set<string>();
  return windows.filter(w => (seen.has(w.key) ? false : (seen.add(w.key), true)));
}
