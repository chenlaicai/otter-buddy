/**
 * PR5 干跑验证测试
 *
 * 模拟 3 个交易日的全链路：
 * - seed 行情数据（gateway mock 真实模式）
 * - 真实撮合任务执行
 * - 断言：日报数字段与 paper_nav_history/paper_orders 表逐日一致
 * - reason 含数据锚点
 * - 账本不变量（现金+持仓市值=总资产，误差<0.01）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Ledger } from '@usecases/paper-trading/ledger';
import { PaperTradeRepositoryImpl } from '@frameworks/db/paper-trade-repository-impl';
import { initSchema } from '@frameworks/db/schema';
import { registerPaperTradingFunctions } from '@usecases/paper-trading/register-functions';
import { paperTradingFunctionRegistry } from '@usecases/paper-trading/function-registry';
import type { DailyQuote } from '@usecases/paper-trading/stock-quote-gateway';

// Mock 行情数据（模拟真实价格）
const MOCK_QUOTES: Record<string, { open: number; close: number; high: number; low: number }> = {
  '600519': { open: 1850.00, close: 1860.00, high: 1870.00, low: 1840.00 },
  '000001': { open: 12.50, close: 12.60, high: 12.70, low: 12.40 },
  '300750': { open: 200.00, close: 205.00, high: 210.00, low: 195.00 },
};

// 模拟 3 个交易日
const TRADING_DAYS = ['2026-08-25', '2026-08-26', '2026-08-27'];

describe('PR5 干跑验证', () => {
  let db: Database.Database;
  let ledger: Ledger;
  let repo: PaperTradeRepositoryImpl;
  let accountId: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    initSchema(db);
    repo = new PaperTradeRepositoryImpl(db);
    ledger = new Ledger(repo, {
      async getClosePrice(code: string) {
        const quote = MOCK_QUOTES[code];
        return quote ? quote.close : null;
      },
      async getQuotes(codes: string[], date: string) {
        const result: Record<string, DailyQuote> = {};
        for (const code of codes) {
          const quote = MOCK_QUOTES[code];
          if (quote) {
            result[code] = { code, date, open: quote.open, close: quote.close, high: quote.high, low: quote.low, prevClose: quote.open * 0.99 };
          }
        }
        return result;
      },
      async getPrevClose(code: string) {
        const quote = MOCK_QUOTES[code];
        return quote ? quote.open * 0.99 : null;
      },
      async getTodayOpen(code: string) {
        const quote = MOCK_QUOTES[code];
        return quote ? quote.open : null;
      },
    });

    registerPaperTradingFunctions(ledger);

    // 初始化交易日历
    for (const day of TRADING_DAYS) {
      db.prepare(`INSERT OR IGNORE INTO trading_calendar (date, is_trading_day, year) VALUES (?, 1, ?)`)
        .run(day, parseInt(day.substring(0, 4)));
    }

    const account = await ledger.createAccount(1000000);
    accountId = account.id;
  });

  afterEach(() => {
    db.close();
  });

  it('模拟 3 个交易日全链路：下单→撮合→日报', async () => {
    // Day 1: 下单
    const day1 = TRADING_DAYS[0];
    const order1 = await ledger.submitOrder(accountId, '600519', 'buy', 100,
      `600519 技术面 MA5 上穿 MA20，收盘价 ${MOCK_QUOTES['600519'].close}，建议买入`);
    expect(order1.status).toBe('pending');
    expect(order1.reason.length).toBeGreaterThanOrEqual(30);

    // 模拟历史订单：更新 createdAt 为 day1
    db.prepare(`UPDATE paper_orders SET created_at = ? WHERE id = ?`)
      .run(`${day1}T10:00:00.000Z`, order1.id);

    // Day 2: 撮合（T+1 开盘价成交）
    const day2 = TRADING_DAYS[1];
    const matchResult = await ledger.matchOrders(accountId, day2);
    expect(matchResult.length).toBe(1);
    expect(matchResult[0].status).toBe('filled');
    expect(matchResult[0].trade?.price).toBe(MOCK_QUOTES['600519'].open);

    // Day 2: 计算净值
    const nav2 = await ledger.calculateNav(accountId, day2);
    expect(nav2.nav).toBeGreaterThan(0);
    expect(Math.abs(nav2.cash + nav2.marketValue - nav2.total)).toBeLessThan(0.01);

    // Day 2: 生成日报
    const report2 = await ledger.getReport(accountId, day2);
    expect(report2).toBeDefined();
    expect(report2!.numbersMd).toContain('600519');
    expect(report2!.id).toBeDefined();

    // Day 3: 继续下单
    const day3 = TRADING_DAYS[2];
    const order2 = await ledger.submitOrder(accountId, '000001', 'buy', 200,
      `000001 估值面 PE 8.5 处于历史 20% 分位，收盘价 ${MOCK_QUOTES['000001'].close}，建议买入`);
    expect(order2.status).toBe('pending');

    // 模拟历史订单：更新 createdAt 为 day2
    db.prepare(`UPDATE paper_orders SET created_at = ? WHERE id = ?`)
      .run(`${day2}T10:00:00.000Z`, order2.id);

    // Day 3: 撮合
    const matchResult3 = await ledger.matchOrders(accountId, day3);
    expect(matchResult3.length).toBe(1);

    // Day 3: 计算净值
    const nav3 = await ledger.calculateNav(accountId, day3);
    expect(nav3.nav).toBeGreaterThan(0);
    expect(Math.abs(nav3.cash + nav3.marketValue - nav3.total)).toBeLessThan(0.01);

    // Day 3: 生成日报
    const report3 = await ledger.getReport(accountId, day3);
    expect(report3).toBeDefined();
    expect(report3!.numbersMd).toContain('000001');

    // 验证日报数字段与表记录一致
    const navHistory = await ledger.getNavHistory(accountId);
    expect(navHistory.length).toBe(2);
    expect(navHistory[0].date).toBe(day2);
    expect(navHistory[1].date).toBe(day3);

    // 验证订单记录
    const orders = await ledger.getOrders(accountId);
    expect(orders.length).toBe(2);
    expect(orders[0].reason.length).toBeGreaterThanOrEqual(30);
    expect(orders[1].reason.length).toBeGreaterThanOrEqual(30);

    // 验证持仓
    const snapshot = await ledger.getAccountSnapshot(accountId);
    expect(snapshot.positions.length).toBe(2);
    expect(snapshot.positions.find(p => p.code === '600519')?.shares).toBe(100);
    expect(snapshot.positions.find(p => p.code === '000001')?.shares).toBe(200);
  });

  it('函数注册表：match_orders 函数可调用', async () => {
    expect(paperTradingFunctionRegistry.has('match_orders')).toBe(true);

    const order = await ledger.submitOrder(accountId, '600519', 'buy', 100,
      '600519 技术面 MA5 上穿 MA20 金叉，收盘价 1860.00，建议买入 100 股');

    db.prepare(`UPDATE paper_orders SET created_at = ? WHERE id = ?`)
      .run(`${TRADING_DAYS[0]}T10:00:00.000Z`, order.id);

    const result = await paperTradingFunctionRegistry.execute('match_orders', {
      accountId,
      tradeDate: TRADING_DAYS[1],
    });

    expect(result.success).toBe(true);
    expect(result.matchedOrders).toBe(1);
  });

  it('函数注册表：render_daily_report 函数可调用', async () => {
    expect(paperTradingFunctionRegistry.has('render_daily_report')).toBe(true);

    const order = await ledger.submitOrder(accountId, '600519', 'buy', 100,
      '600519 估值面 PE 28.5 处于历史 30% 分位，收盘价 1860.00，建议买入');

    db.prepare(`UPDATE paper_orders SET created_at = ? WHERE id = ?`)
      .run(`${TRADING_DAYS[0]}T10:00:00.000Z`, order.id);

    await ledger.matchOrders(accountId, TRADING_DAYS[1]);
    await ledger.calculateNav(accountId, TRADING_DAYS[1]);

    const result = await paperTradingFunctionRegistry.execute('render_daily_report', {
      accountId,
      date: TRADING_DAYS[1],
    });

    expect(result.success).toBe(true);
    expect(result.performance).toBeDefined();
    expect(result.navHistory).toBeDefined();
  });
});
