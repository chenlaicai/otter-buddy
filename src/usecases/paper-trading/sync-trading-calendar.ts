/**
 * 交易日历同步
 * 
 * 从 akshare（stock-cli.py calendar）同步交易日历到 trading_calendar 表。
 * 同步失败时 fallback 到内置 2026 年节假日表（国务院安排）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PaperTradeRepository } from "./paper-trade-repository";

/** stock-cli.py 相对路径 */
const STOCK_CLI_REL = "scripts/stock-cli.py";

/**
 * 探测 Python 解释器路径。
 * 优先级：STOCK_PYTHON 环境变量 > <repo>/.venv-stock/bin/python > 系统 python3
 * N3 注意：此函数与 stock-quote-gateway-impl.ts 中的实现完全一致，
 * 单边修改时需同步另一处。原因：usecases 层不能导入 frameworks 层。
 */
function resolvePython(repoRoot: string): string {
  const envPython = process.env.STOCK_PYTHON;
  if (envPython && existsSync(envPython)) return envPython;
  const venvPython = join(repoRoot, ".venv-stock", "bin", "python");
  if (existsSync(venvPython)) return venvPython;
  return "python3";
}

/** 通过 stock-cli.py calendar 同步交易日历 */
async function fetchTradingDatesFromCli(repoRoot: string, year: number): Promise<string[] | null> {
  const scriptPath = resolve(repoRoot, STOCK_CLI_REL);
  const pythonPath = resolvePython(repoRoot);
  const fullArgs = [scriptPath, "calendar", "--year", String(year)];

  return new Promise((res) => {
    const proc = spawn(pythonPath, fullArgs, {
      cwd: repoRoot,
      timeout: 30_000,
      shell: false,
    });

    let stdout = "";
    let _stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { _stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        res(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as { error?: string; trading_dates?: string[] };
        if (parsed.error || !parsed.trading_dates) {
          res(null);
          return;
        }
        res(parsed.trading_dates);
      } catch {
        res(null);
      }
    });
    proc.on("error", () => res(null));
  });
}

/**
 * 2026 年 A 股节假日（国务院安排）
 * 用于 akshare 同步失败时的 fallback
 */
const HOLIDAYS_2026 = [
  // 元旦
  "2026-01-01", "2026-01-02", "2026-01-03",
  // 春节
  "2026-02-14", "2026-02-15", "2026-02-16", "2026-02-17",
  "2026-02-18", "2026-02-19", "2026-02-20",
  // 清明
  "2026-04-04", "2026-04-05", "2026-04-06",
  // 劳动节
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  // 端午
  "2026-06-19", "2026-06-20", "2026-06-21",
  // 中秋+国庆
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
  "2026-10-05", "2026-10-06", "2026-10-07",
];

/**
 * 生成 fallback 日历：工作日（周一-周五）且不在节假日中 = 交易日
 */
function generateFallbackCalendar(year: number): Array<{ date: string; isTradingDay: boolean }> {
  const holidays = year === 2026 ? new Set(HOLIDAYS_2026) : new Set<string>();
  const entries: Array<{ date: string; isTradingDay: boolean }> = [];

  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    // N1 修复：用本地时区组件拼接，禁用 toISOString()（UTC 导致 +8 时区偏移一天）
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${dd}`;
    // 周一到周五 + 不在节假日中 = 交易日
    const isTradingDay = day >= 1 && day <= 5 && !holidays.has(dateStr);
    entries.push({ date: dateStr, isTradingDay });
  }

  return entries;
}

/**
 * 同步交易日历
 * 
 * 优先从 akshare 获取，失败则用 fallback 内置节假日表。
 * 返回同步的条目数。
 */
export async function syncTradingCalendar(
  repo: PaperTradeRepository,
  repoRoot: string,
  year?: number,
): Promise<{ count: number; source: 'akshare' | 'fallback' }> {
  const targetYear = year ?? new Date().getFullYear();

  // 尝试 akshare
  const tradingDates = await fetchTradingDatesFromCli(repoRoot, targetYear);

  if (tradingDates && tradingDates.length > 0) {
    // akshare 返回的是交易日列表，需要生成完整日历（含非交易日）
    const tradingDateSet = new Set(tradingDates);
    const fallback = generateFallbackCalendar(targetYear);
    const entries = fallback.map(e => ({
      date: e.date,
      isTradingDay: tradingDateSet.has(e.date),
    }));

    await repo.syncTradingCalendar(entries);
    return { count: entries.length, source: 'akshare' };
  }

  // Fallback：内置节假日表
  const entries = generateFallbackCalendar(targetYear);
  await repo.syncTradingCalendar(entries);
  return { count: entries.length, source: 'fallback' };
}
