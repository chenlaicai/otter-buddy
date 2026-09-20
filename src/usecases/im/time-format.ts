/**
 * IM 出站时间格式化共享模块（F20260920tdun）。
 *
 * 出站时间展示统一收口：assistant-session 收篇摘要与 feishu /history 的时间戳
 * 显式锚定 Asia/Shanghai，不再依赖服务器进程恰好跑在该时区。
 *
 * 与前端 web/src/lib/utils.ts 的 fmtTime/fmtTimeShort 是不同运行环境的平行实现：
 * - 前端跑在用户浏览器，本地时区即用户时区，get*() 系正确；
 * - backend 无法假定进程时区（部署机可能在任意 UTC 偏移），必须显式传 timeZone。
 */

/** 出站展示锚定时区：产品语义为中文用户（飞书/微信），显式 Asia/Shanghai */
export const DISPLAY_TIMEZONE = "Asia/Shanghai";

/**
 * UTC ISO 时间戳 → `YYYY-MM-DD HH:mm`（Asia/Shanghai）。
 * IM 出站统一格式（与前端 fmtTimeShort 同构，分钟精度——IM 消息流无秒级排查需求）。
 * 无效输入原样返回（与前端 fmtTime 系的防御语义一致）。
 */
export function fmtImTime(iso: string): string {
  if (!iso) return iso;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
