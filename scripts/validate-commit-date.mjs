#!/usr/bin/env node
/**
 * F20260825dva2: commit-msg 钩子 / CI 日期校验的单一真相源。
 *
 * 抽取 .githooks/commit-msg 和 .github/workflows/ci.yml 中重复的
 * 日期校验逻辑（解析 F 类特性 ID 前 8 位、与系统日期比对、偏差 >2 天拒绝），
 * 消灭双处维护。
 *
 * TZ 根除：用 Intl.DateTimeFormat.formatToParts() 替代 toLocaleString 字符串解析，
 * 消除 PR #435 检视时发现的 ~0.3s/roundtrip 理论漂移。
 *
 * 用法：
 *   CLI: node scripts/validate-commit-date.mjs "[F20260825abcd]..."
 *   或:  echo "[F20260825abcd]..." | node scripts/validate-commit-date.mjs
 *
 * 退出码：
 *   0 = 通过（ok / skip）
 *   1 = 日期偏差 > 2 天 或 非法日期（bad_date）
 */

/**
 * 用 Intl.DateTimeFormat.formatToParts 获取指定时区的年/月/日。
 * Why: 不用 toLocaleString 字符串解析——PR #435 检视发现其 roundtrip 有 ~0.3s 理论漂移。
 *
 * @param {Date} date
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number }}
 */
function getDatePartsInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type === 'year') parts.year = Number(value);
    else if (type === 'month') parts.month = Number(value);
    else if (type === 'day') parts.day = Number(value);
  }
  return parts;
}

/**
 * 校验特性 ID 日期与系统日期的偏差。
 *
 * @param {string} firstLine - commit message 首行
 * @param {Date} [now] - 当前时间（注入点，测试用）
 * @returns {{ valid: boolean, status: 'ok'|'skip'|'fail'|'bad_date', idDate?: string, systemDate?: string, diffDays?: number }}
 */
export function validateCommitDate(firstLine, now = new Date()) {
  const match = firstLine.match(/^\[F([0-9]{8})/);

  // R 类或无 ID：不校验日期（R 类日期是研究文档创建日，跨天迭代时必然不同）
  if (!match) {
    return { valid: true, status: 'skip' };
  }

  const idStr = match[1];
  const idYear = Number(idStr.slice(0, 4));
  const idMonth = Number(idStr.slice(4, 6));
  const idDay = Number(idStr.slice(6, 8));

  // Why: new Date(y, m, d) 会静默滚转非法日期（如 13月→次年1月，32日→进位），
  // 必须显式校验范围，否则 bad_date 永远不会触发。
  const daysInMonth = new Date(idYear, idMonth, 0).getDate();
  if (idMonth < 1 || idMonth > 12 || idDay < 1 || idDay > daysInMonth) {
    return { valid: false, status: 'bad_date' };
  }

  const { year: nowYear, month: nowMonth, day: nowDay } = getDatePartsInZone(now, 'Asia/Shanghai');

  const idDate = new Date(idYear, idMonth - 1, idDay);
  const today = new Date(nowYear, nowMonth - 1, nowDay);

  const diffDays = Math.round(
    Math.abs(idDate.getTime() - today.getTime()) / 86_400_000
  );

  if (diffDays > 2) {
    return {
      valid: false,
      status: 'fail',
      idDate: `${idYear}${String(idMonth).padStart(2, '0')}${String(idDay).padStart(2, '0')}`,
      systemDate: `${nowYear}${String(nowMonth).padStart(2, '0')}${String(nowDay).padStart(2, '0')}`,
      diffDays,
    };
  }

  return { valid: true, status: 'ok', diffDays };
}

// CLI 入口：仅直接执行时运行，被 import 时不触发
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const input = process.argv[2] || readFileSync(0, 'utf-8');
  const firstLine = input.split('\n')[0].trim();
  if (!firstLine) process.exit(0);

  const result = validateCommitDate(firstLine);
  if (!result.valid) {
    const msg = result.status === 'bad_date'
      ? `错误：特性 ID 日期非法（如 13 月/40 日/Feb 30）。请检查特性 ID 日期部分。\n`
      : `错误：特性 ID 日期与系统日期不符（偏差 ${result.diffDays} 天）。\n` +
        `  ID 日期: ${result.idDate}  系统日期: ${result.systemDate}\n` +
        `请跑 date 确认今天日期，修正 F 类特性 ID 后重新提交。\n`;
    process.stderr.write(msg);
    process.exit(1);
  }
}
