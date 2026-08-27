/**
 * 行情数据网关 CLI 实现
 * 
 * 通过 child_process.spawn 调 stock-cli.py kline --adjust "" 获取不复权行情。
 * 复用 stock-tools.ts 的 spawn 模式（参数数组不经 shell，防注入）。
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolvePython } from "@frameworks/stock/python";
import type { StockQuoteGateway, DailyQuote } from "@usecases/paper-trading/stock-quote-gateway";

/** stock-cli.py 相对仓库根的路径 */
const STOCK_CLI_REL = "scripts/stock-cli.py";

/** 默认超时 60 秒 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 最大重试次数（东财接口不稳定，章鱼实测 3 连 2 败） */
const MAX_RETRIES = 2;

/** 重试退避间隔（ms） */
const RETRY_DELAY_MS = 1_000;

/** 延迟 ms */
function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 执行 stock-cli.py kline 命令（带重试）
 *
 * N3 修复：东财接口不稳定（章鱼实测 3 连 2 败），加 2 次退避重试。
 * 重试间隔 1s/2s（指数退避）。
 */
async function executeKline(
  repoRoot: string,
  code: string,
  days: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>[] | null> {
  const scriptPath = resolve(repoRoot, STOCK_CLI_REL);
  const pythonPath = resolvePython(repoRoot);
  // --raw 返回完整记录列表；adjust="" 不复权
  const fullArgs = [scriptPath, "kline", code, "--days", String(days), "--adjust", "", "--raw"];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS * attempt); // 1s, 2s
    }

    const result = await new Promise<Record<string, unknown>[] | null>((res) => {
      const proc = spawn(pythonPath, fullArgs, {
        cwd: repoRoot,
        timeout: timeoutMs,
        shell: false, // 参数数组传递不经 shell，防注入
      });

      let stdout = "";
      let _stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { _stderr += chunk.toString(); });
      proc.on("close", (code_) => {
        if (code_ !== 0) {
          res(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as { error?: string; data?: Record<string, unknown>[] };
          if (parsed.error || !parsed.data) {
            res(null);
            return;
          }
          res(parsed.data);
        } catch {
          res(null);
        }
      });
      proc.on("error", () => res(null));
    });

    if (result) return result;
  }

  return null; // 全部重试失败
}

/** 从 kline 记录中提取 DailyQuote */
function extractQuote(
  code: string,
  records: Record<string, unknown>[],
  targetDate: string,
): DailyQuote | null {
  // 找到目标日期的记录
  const idx = records.findIndex(r => String(r.date) === targetDate);
  if (idx < 0) return null;

  const row = records[idx];
  return {
    code,
    date: targetDate,
    open: Number(row.open),
    close: Number(row.close),
    prevClose: idx > 0 ? Number(records[idx - 1].close) : Number(row.prev_close ?? row.close),
    high: Number(row.high),
    low: Number(row.low),
  };
}

export class StockQuoteGatewayImpl implements StockQuoteGateway {
  constructor(private readonly repoRoot: string) {}

  async getQuotes(codes: string[], date: string): Promise<Record<string, DailyQuote>> {
    // 取最近 10 个交易日（覆盖目标日期 + buffer）
    const results: Record<string, DailyQuote> = {};
    const promises = codes.map(async (code) => {
      const records = await executeKline(this.repoRoot, code, 10);
      if (!records) return;
      const quote = extractQuote(code, records, date);
      if (quote) results[code] = quote;
    });
    await Promise.all(promises);
    return results;
  }

  async getClosePrice(code: string, date: string): Promise<number | null> {
    const records = await executeKline(this.repoRoot, code, 10);
    if (!records) return null;
    const quote = extractQuote(code, records, date);
    return quote?.close ?? null;
  }

  async getPrevClose(code: string, date: string): Promise<number | null> {
    const records = await executeKline(this.repoRoot, code, 10);
    if (!records) return null;
    const quote = extractQuote(code, records, date);
    return quote?.prevClose ?? null;
  }

  async getTodayOpen(code: string, date: string): Promise<number | null> {
    const records = await executeKline(this.repoRoot, code, 10);
    if (!records) return null;
    const quote = extractQuote(code, records, date);
    return quote?.open ?? null;
  }
}
