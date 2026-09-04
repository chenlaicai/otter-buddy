/**
 * StockQuoteGatewayImpl 兜底链测试——mock child_process，不真调 python。
 *
 * F20260904pptq：东财双路拒连 + 新浪日线当日 T-1 滞后的双层故障下，
 * getClosePrice/getPrevClose/getTodayOpen/getQuotes 走新浪实时行情（quote 命令）兜底。
 * 覆盖：兜底触发、日期错配拒绝、兜底链全挂返 null。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { StockQuoteGatewayImpl } from "@frameworks/stock/stock-quote-gateway-impl";

const mockSpawn = vi.mocked(spawn);

/** kline raw 输出（新浪源，当日缺席） */
const KLINE_NO_TODAY = JSON.stringify({
  code: "600519",
  adjust: "",
  source: "sina",
  count: 2,
  data: [
    { date: "2026-09-02", close: 1297.5 },
    { date: "2026-09-03", close: 1298.88 },
  ],
});

/** kline raw 输出（含当日） */
const KLINE_WITH_TODAY = JSON.stringify({
  code: "600519",
  adjust: "",
  source: "sina",
  count: 3,
  data: [
    { date: "2026-09-02", close: 1297.5 },
    { date: "2026-09-03", close: 1298.88 },
    { date: "2026-09-04", open: 1295.88, high: 1338.86, low: 1295.6, close: 1330.0 },
  ],
});

const QUOTE_TODAY = JSON.stringify({
  code: "600519",
  source: "sina",
  name: "贵州茅台",
  open: 1295.88,
  prev_close: 1298.88,
  price: 1330.0,
  high: 1338.86,
  low: 1295.6,
  date: "2026-09-04",
  time: "15:34:59",
});

function createMockProcess(stdout: string, exitCode: number | null = 0) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  }, 5);
  return proc;
}

/** 按 args 关键字路由 mock 响应 */
function routeMock(routes: Array<{ match: string[]; stdout: string; exitCode?: number | null }>) {
  mockSpawn.mockImplementation(((_python: string, args: string[]) => {
    for (const r of routes) {
      if (r.match.every(m => args.includes(m))) {
        return createMockProcess(r.stdout, r.exitCode ?? 0);
      }
    }
    return createMockProcess("", 1);
  }) as any);
}

describe("StockQuoteGatewayImpl 兜底链 (F20260904pptq)", () => {
  const repoRoot = "/fake/repo";
  let gateway: StockQuoteGatewayImpl;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new StockQuoteGatewayImpl(repoRoot);
  });

  it("getClosePrice：kline 含当日 → 直接取日线收盘价（不走兜底）", async () => {
    routeMock([{ match: ["kline"], stdout: KLINE_WITH_TODAY }]);
    const price = await gateway.getClosePrice("600519", "2026-09-04");
    expect(price).toBe(1330.0);
    // 只应有一次 kline 调用，无 quote 调用
    const quoteCalls = mockSpawn.mock.calls.filter(c => (c[1] as string[]).includes("quote"));
    expect(quoteCalls.length).toBe(0);
  });

  it("getClosePrice：kline 当日缺席 → quote 兜底取实时价", async () => {
    routeMock([
      { match: ["kline"], stdout: KLINE_NO_TODAY },
      { match: ["quote"], stdout: QUOTE_TODAY },
    ]);
    const price = await gateway.getClosePrice("600519", "2026-09-04");
    expect(price).toBe(1330.0);
  });

  it("getClosePrice：quote 日期错配（跨日）→ 拒绝兜底返 null", async () => {
    const staleQuote = JSON.stringify({ ...JSON.parse(QUOTE_TODAY), date: "2026-09-03", price: 1298.88 });
    routeMock([
      { match: ["kline"], stdout: KLINE_NO_TODAY },
      { match: ["quote"], stdout: staleQuote },
    ]);
    const price = await gateway.getClosePrice("600519", "2026-09-04");
    expect(price).toBeNull();
  });

  it("getClosePrice：兜底链全挂 → null", async () => {
    routeMock([
      { match: ["kline"], stdout: "", exitCode: 1 },
      { match: ["quote"], stdout: "", exitCode: 1 },
    ]);
    // kline 3 次 + quote 3 次重试，退避 1s+2s 序列叠加 ≈ 6s，超出默认 5s 超时
    const price = await gateway.getClosePrice("600519", "2026-09-04");
    expect(price).toBeNull();
  }, 30_000);

  it("getPrevClose：当日缺席 → quote prev_close 兜底", async () => {
    routeMock([
      { match: ["kline"], stdout: KLINE_NO_TODAY },
      { match: ["quote"], stdout: QUOTE_TODAY },
    ]);
    const prev = await gateway.getPrevClose("600519", "2026-09-04");
    expect(prev).toBe(1298.88);
  });

  it("getTodayOpen：当日缺席 → quote open 兜底", async () => {
    routeMock([
      { match: ["kline"], stdout: KLINE_NO_TODAY },
      { match: ["quote"], stdout: QUOTE_TODAY },
    ]);
    const open = await gateway.getTodayOpen("600519", "2026-09-04");
    expect(open).toBe(1295.88);
  });

  it("getQuotes：当日缺席 → 实时行情拼最小 DailyQuote（撮合不卡 pending）", async () => {
    routeMock([
      { match: ["kline"], stdout: KLINE_NO_TODAY },
      { match: ["quote"], stdout: QUOTE_TODAY },
    ]);
    const quotes = await gateway.getQuotes(["600519"], "2026-09-04");
    expect(quotes["600519"]).toBeDefined();
    expect(quotes["600519"].close).toBe(1330.0);
    expect(quotes["600519"].prevClose).toBe(1298.88);
    expect(quotes["600519"].date).toBe("2026-09-04");
  });

  it("getQuotes：kline 正常 → 不走兜底", async () => {
    routeMock([{ match: ["kline"], stdout: KLINE_WITH_TODAY }]);
    const quotes = await gateway.getQuotes(["600519"], "2026-09-04");
    expect(quotes["600519"].close).toBe(1330.0);
    const quoteCalls = mockSpawn.mock.calls.filter(c => (c[1] as string[]).includes("quote"));
    expect(quoteCalls.length).toBe(0);
  });
});
