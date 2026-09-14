#!/usr/bin/env node
/**
 * F20260825dva2: commit-msg 钩子 / CI 日期校验的单一真相源。
 *
 * 抽取 .githooks/commit-msg 和 .github/workflows/ci.yml 中重复的
 * 日期校验逻辑（解析 F 类特性 ID 前 8 位、与基准日期比对、偏差 >7 天拒绝（F20260913ctlv：±2→±7，原 ±2 系时区漂移推导，误伤长周期特性 PR）），
 * 消灭双处维护。
 *
 * TZ 根除：用 Intl.DateTimeFormat.formatToParts() 替代 toLocaleString 字符串解析，
 * 消除 PR #435 检视时发现的 ~0.3s/roundtrip 理论漂移。
 *
 * F20260914prdb: 基准时间可注入——CLI 支持 `--at <ISO>`。CI 的 PR 标题校验传 PR
 * 创建时间（github.event.pull_request.created_at）+ 当前时间双基准任一通过：
 * PR 全生命周期（创建日 ID → 定稿改名合入日）均肠通——squash 模型下 PR 标题即 main
 * 历史，特性文档 ID 必须 ≡ PR 标题 ID（搭档决策 2026-09-14），定稿改名不再被拦。
 * 另支持 `--warn-on-drift`（commit-msg 钩子用）：偏差超窗降为警告 exit 0（中间 commit
 * 标题会被 squash 抹掉，阻断是纯摩擦）；bad_date 非法日期仍硬拦。
 *
 * 用法：
 *   CLI: node scripts/validate-commit-date.mjs "[F20260825abcd]..."
 *        node scripts/validate-commit-date.mjs --at "2026-09-04T03:56:11Z" "[F20260904wxeg]..."
 *        node scripts/validate-commit-date.mjs --warn-on-drift "[F20260801abcd]..."  # 钩子用
 *   或:  echo "[F20260825abcd]..." | node scripts/validate-commit-date.mjs
 *
 * 退出码：
 *   0 = 通过（ok / skip）
 *   1 = 日期偏差 > 7 天 或 非法日期（bad_date）（F20260913ctlv：±2→±7）
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
 * 校验特性 ID 日期与基准日期的偏差。
 *
 * @param {string} firstLine - commit message 首行
 * @param {Date} [now] - 基准时间（注入点，测试用；默认当前时间）
 * @returns {{ valid: boolean, status: 'ok'|'skip'|'fail'|'bad_date', idDate?: string, baseDate?: string, diffDays?: number }}
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

  if (diffDays > 7) {
    return {
      valid: false,
      status: 'fail',
      idDate: `${idYear}${String(idMonth).padStart(2, '0')}${String(idDay).padStart(2, '0')}`,
      baseDate: `${nowYear}${String(nowMonth).padStart(2, '0')}${String(nowDay).padStart(2, '0')}`,
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
  // F20260914prdb: --at <ISO> 注入基准时间（CI 传 PR 创建时间，与当前时间双基准任一通过）
  // F20260914prdb: --warn-on-drift 偏差超窗降为警告（commit-msg 钩子用，bad_date 仍硬拦）
  const args = process.argv.slice(2);
  const atIdx = args.indexOf('--at');
  const warnOnDrift = args.includes('--warn-on-drift');
  if (warnOnDrift) args.splice(args.indexOf('--warn-on-drift'), 1);
  let atDate = null;
  if (atIdx !== -1) {
    const at = args[atIdx + 1];
    if (!at) {
      process.stderr.write('错误：--at 需要一个 ISO 8601 时间参数\n');
      process.exit(1);
    }
    const parsed = new Date(at);
    if (Number.isNaN(parsed.getTime())) {
      process.stderr.write(`错误：--at 参数不是合法的 ISO 时间：${at}\n`);
      process.exit(1);
    }
    atDate = parsed;
    args.splice(atIdx, 2);
  }
  const input = args[0] || readFileSync(0, 'utf-8');
  const firstLine = input.split('\n')[0].trim();
  if (!firstLine) process.exit(0);

  // 双基准判定（--at 存在时）：创建基准与当前基准任一通过即过；bad_date 任一命中即拦
  let result = validateCommitDate(firstLine, new Date());
  if (atDate) {
    const atResult = validateCommitDate(firstLine, atDate);
    if (atResult.status === 'bad_date') {
      result = atResult;
    } else if (atResult.valid) {
      result = atResult;
    }
  }

  if (!result.valid) {
    if (result.status === 'bad_date') {
      process.stderr.write('错误：特性 ID 日期非法（如 13 月/40 日/Feb 30）。请检查特性 ID 日期部分。\n');
      process.exit(1);
    }
    const msg = `错误：特性 ID 日期与基准日期不符（偏差 ${result.diffDays} 天）。\n` +
      `  ID 日期: ${result.idDate}  基准日期: ${result.baseDate}\n` +
      `请跑 date 确认今天日期，修正 F 类特性 ID 后重新提交。\n`;
    if (warnOnDrift) {
      process.stderr.write(`警告（不阻断）：${msg}`);
      process.exit(0);
    }
    process.stderr.write(msg);
    process.exit(1);
  }
}
