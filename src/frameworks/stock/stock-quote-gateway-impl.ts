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
 * 执行 stock-cli.py 任意命令并解析 JSON 输出（带重试）。
 *
 * 从 executeKline 提取的通用执行层：spawn + JSON 解析 + 退避重试共享同一套逻辑，
 * kline/quote 两命令复用（F20260904pptq）。extractor 返回 null 视为本次失败走重试。
 */
async function executeCliJson<T>(
  repoRoot: string,
  cliArgs: string[],
  timeoutMs: number,
  extractor: (parsed: Record<string, unknown>) => T | null,
): Promise<T | null> {
  const scriptPath = resolve(repoRoot, STOCK_CLI_REL);
  const pythonPath = resolvePython(repoRoot);
  const fullArgs = [scriptPath, ...cliArgs];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_DELAY_MS * attempt); // 1s, 2s
    }

    const result = await new Promise<T | null>((res) => {
      const proc = spawn(pythonPath, fullArgs, {
        cwd: repoRoot,
        timeout: timeoutMs,
        shell: false, // 参数数组传递不经 shell，防注入
      });

      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.on("close", (code_) => {
        if (code_ !== 0) {
          res(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
          res(extractor(parsed));
        } catch {
          res(null);
        }
      });
      proc.on("error", () => res(null));
    });

    if (result !== null) return result;
  }

  return null; // 全部重试失败
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
  return executeCliJson<Record<string, unknown>[]>(
    repoRoot, ["kline", code, "--days", String(days), "--adjust", "", "--raw"],
    timeoutMs,
    (parsed) => {
      if (parsed.error || !parsed.data) return null;
      return parsed.data as Record<string, unknown>[];
    },
  );
}

/**
 * 执行 stock-cli.py quote 命令（新浪实时行情，当日价）。
 *
 * F20260904pptq：东财双路拒连（主源）+ 新浪日线当日更新滞后（备源 T-1）双层故障下，
 * 当日收盘价的唯一可用源。getClosePrice 等当日价场景的兑底链终点。
 */
async function executeQuote(
  repoRoot: string,
  code: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ price: number; open: number; prevClose: number; date: string } | null> {
  return executeCliJson<{ price: number; open: number; prevClose: number; date: string }>(
    repoRoot, ["quote", code],
    timeoutMs,
    (parsed) => {
      if (parsed.error || typeof parsed.price !== "number" || !parsed.date) return null;
      return {
        price: parsed.price,
        open: typeof parsed.open === "number" ? parsed.open : NaN,
        prevClose: typeof parsed.prev_close === "number" ? parsed.prev_close : NaN,
        date: String(parsed.date),
      };
    },
  );
}

/* 旧版内联实现已由 executeCliJson 重构替代（F20260904pptq），见上方 executeKline/executeQuote */

/** 从 kline 记录中提取 DailyQuote */
function extractQuote(
  code: string,
  records: Record<string, unknown>[],
  targetDate: string,
): DailyQuote | null {
  // 找到目标日期的记录；东财挂 + 新浪日线 T-1 滞后时当日记录常缺席（F20260904pptq）
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
      const quote = extractQuote(code, records ?? [], date);
      if (quote) {
        results[code] = quote;
        return;
      }
      // 兑底链（F20260904pptq）：当日 kline 缺席时用实时行情拼一个最小 DailyQuote，
      // 使撮合不因数据源故障整日卡 pending。high/low 取实时值，prevClose 缺失时
      // 用日线最后一行（当日缺席时即 T-1 收盘）。
      const realtime = await executeQuote(this.repoRoot, code);
      if (realtime && realtime.date === date) {
        const lastKline = (records ?? []).at(-1);
        results[code] = {
          code,
          date,
          open: Number.isFinite(realtime.open) ? realtime.open : realtime.price,
          close: realtime.price,
          prevClose: Number.isFinite(realtime.prevClose)
            ? realtime.prevClose
            : lastKline ? Number(lastKline.close) : realtime.price,
          high: realtime.price,
          low: realtime.price,
        };
      }
    });
    await Promise.all(promises);
    return results;
  }

  async getClosePrice(code: string, date: string): Promise<number | null> {
    const records = await executeKline(this.repoRoot, code, 10);
    const quote = extractQuote(code, records ?? [], date);
    if (quote) return quote.close;

    // 兑底链：kline 日线匹配不到当日（东财挂 + 新浪日线 T-1 滞后）时
    // 取新浪实时行情的当日价。收盘后该价即当日收盘价（盘中则为最新价，
    // 与“最新收盘价撮合”语义一致）。日期一致性校验防跨日错配。
    const realtime = await executeQuote(this.repoRoot, code);
    if (realtime && realtime.date === date) return realtime.price;

    return null;
  }

  async getPrevClose(code: string, date: string): Promise<number | null> {
    const records = await executeKline(this.repoRoot, code, 10);
    if (!records) return null;
    const quote = extractQuote(code, records, date);
    if (quote) return quote.prevClose;

    // 当日 kline 缺席时：目标日=今日则实时行情的 prev_close 即上一交易日收盘价；
    // 其余场景日线正常覆盖不走此分支。NaN 防御：字段缺失时不兑底。
    const realtime = await executeQuote(this.repoRoot, code);
    if (realtime && realtime.date === date && Number.isFinite(realtime.prevClose)) {
      return realtime.prevClose;
    }
    return null;
  }

  async getTodayOpen(code: string, date: string): Promise<number | null> {
    const records = await executeKline(this.repoRoot, code, 10);
    const quote = extractQuote(code, records ?? [], date);
    if (quote) return quote.open;

    // 兑底：实时行情当日开盘价
    const realtime = await executeQuote(this.repoRoot, code);
    if (realtime && realtime.date === date && Number.isFinite(realtime.open)) {
      return realtime.open;
    }
    return null;
  }
}
